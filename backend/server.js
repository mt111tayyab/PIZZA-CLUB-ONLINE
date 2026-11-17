'use strict';
/**
 * Pizza Club Pindi Gheb — online ordering backend (v2.0.0).
 *
 * Node.js ONLY, ZERO npm dependencies (Node standard library only).
 * JSON file store in ./data/ (menu.json + orders.json).
 *
 * HONEST NOTE: this is a local / demo backend. It has NO auth, NO rate
 * limiting, NO database and NO input sanitisation beyond the validation
 * below. It is fine to run on the restaurant's own computer or a small
 * trusted host while testing online ordering. Do NOT present it as a
 * production-hardened backend, and do not expose it to the open internet
 * without adding auth, HTTPS and a real database first.
 *
 * Run:  node backend/server.js        (PORT env var overrides 3001)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = path.join(__dirname, 'data');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

const ALLOWED_STATUSES = [
  'received', 'accepted', 'preparing', 'ready',
  'out_for_delivery', 'delivered', 'completed',
  'cancelled', 'rejected',
];
// Pizza Club advertises FREE DELIVERY, so online delivery costs nothing.
const DELIVERY_FEE_PAISA = 0;

// ---------------------------------------------------------------- store ---

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MENU_FILE)) {
    throw new Error(
      'menu.json is missing from backend/data/. It is generated from the ' +
      'Flutter seed data (lib/data/seed_data.dart) — do not hand-write it.'
    );
  }
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, '[]\n', 'utf8');
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJson(file, value) {
  // Write to a temp file then rename, so a crash mid-write never leaves a
  // half-written orders file behind.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

let menu = null; // loaded once at startup; menu.json is edited by hand/admin

function loadMenu() {
  menu = readJson(MENU_FILE);
  if (!menu || !Array.isArray(menu.categories) || !Array.isArray(menu.products)) {
    throw new Error('menu.json is not a valid menu (needs categories + products arrays).');
  }
}

function loadOrders() {
  return readJson(ORDERS_FILE, []);
}

function saveOrders(orders) {
  writeJson(ORDERS_FILE, orders);
}

function nextOrderNumber(orders) {
  let max = 0;
  for (const o of orders) {
    const m = /^PC-ONLINE-(\d+)$/.exec(o.order_number || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'PC-ONLINE-' + String(max + 1).padStart(4, '0');
}

function findProduct(id) {
  return menu.products.find((p) => p.id === id) || null;
}

// --------------------------------------------------------------- http -----

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large (max 1 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function asNonEmptyString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// POST /api/orders — validate, price from the menu, store.
function createOrder(body) {
  const customerName = asNonEmptyString(body.customer_name);
  if (!customerName) return { error: 'customer_name is required.', status: 400 };
  const customerPhone = asNonEmptyString(body.customer_phone);
  if (customerPhone.length < 10) {
    return { error: 'customer_phone must be at least 10 characters.', status: 400 };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: 'items must be a non-empty array.', status: 400 };
  }
  const type = asNonEmptyString(body.type) || 'delivery';
  if (!['delivery', 'takeaway', 'dine-in'].includes(type)) {
    return { error: 'type must be delivery, takeaway or dine-in.', status: 400 };
  }
  const paymentMethod = asNonEmptyString(body.payment_method) || 'Cash on Delivery';
  if (!['Cash', 'Cash on Delivery', 'Card', 'Other'].includes(paymentMethod)) {
    return { error: 'payment_method must be Cash, Cash on Delivery, Card or Other.', status: 400 };
  }

  // Price every line from the menu — never trust client-supplied totals.
  const pricedItems = [];
  let subtotal = 0;
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'Each item must be an object with product_id and qty.', status: 400 };
    }
    const product = findProduct(asNonEmptyString(raw.product_id));
    if (!product) {
      return { error: `Unknown product_id: ${asNonEmptyString(raw.product_id) || '(missing)'}.`, status: 400 };
    }
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      return { error: `qty for ${product.name} must be an integer of at least 1.`, status: 400 };
    }
    // Size (pizzas only): must exist on the product when given.
    let unitPrice = product.price_paisa;
    let sizeName = '';
    if (raw.size_name != null && asNonEmptyString(raw.size_name) !== '') {
      sizeName = asNonEmptyString(raw.size_name);
      const size = (product.sizes || []).find((s) => s.name === sizeName);
      if (!size) {
        return { error: `Unknown size "${sizeName}" for ${product.name}.`, status: 400 };
      }
      unitPrice = size.price_paisa;
    }
    // Add-ons: must exist on the product when given.
    const addonNames = Array.isArray(raw.addons)
      ? raw.addons.map((a) => asNonEmptyString(a)).filter(Boolean)
      : [];
    for (const name of addonNames) {
      const addon = (product.addons || []).find((a) => a.name === name);
      if (!addon) {
        return { error: `Unknown add-on "${name}" for ${product.name}.`, status: 400 };
      }
      unitPrice += addon.price_paisa;
    }
    pricedItems.push({
      product_id: product.id,
      product_name: product.name,
      size_name: sizeName,
      addons: addonNames,
      qty,
      unit_price_paisa: unitPrice,
      total_paisa: unitPrice * qty,
    });
    subtotal += unitPrice * qty;
  }

  const discountPaisa = 0; // no discount codes in v2.0.0
  const deliveryFeePaisa = type === 'delivery' ? DELIVERY_FEE_PAISA : 0;

  const orders = loadOrders();
  const order = {
    id: crypto.randomUUID(),
    order_number: nextOrderNumber(orders),
    customer_name: customerName,
    customer_phone: customerPhone,
    address: asNonEmptyString(body.address),
    instructions: asNonEmptyString(body.instructions),
    type,
    payment_method: paymentMethod,
    status: 'received',
    items: pricedItems,
    subtotal_paisa: subtotal,
    discount_paisa: discountPaisa,
    delivery_fee_paisa: deliveryFeePaisa,
    total_paisa: subtotal - discountPaisa + deliveryFeePaisa,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  orders.push(order);
  saveOrders(orders);
  return { order, status: 201 };
}

function handle(req, res) {
  // CORS preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','orders','PC-ONLINE-0001']

  // GET /api/menu
  if (req.method === 'GET' && parts.join('/') === 'api/menu') {
    sendJson(res, 200, menu);
    return;
  }

  // GET /api/orders
  if (req.method === 'GET' && parts.join('/') === 'api/orders') {
    sendJson(res, 200, loadOrders());
    return;
  }

  // GET /api/orders/:id  (matches id OR order_number, so customers can
  // track by the PC-ONLINE-xxxx number on their confirmation)
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'orders') {
    const id = decodeURIComponent(parts[2]);
    const order = loadOrders().find((o) => o.id === id || o.order_number === id);
    if (!order) return sendError(res, 404, `No order found with id ${id}.`);
    sendJson(res, 200, order);
    return;
  }

  // POST /api/orders
  if (req.method === 'POST' && parts.join('/') === 'api/orders') {
    readBody(req).then(
      (body) => {
        let result;
        try {
          result = createOrder(body);
        } catch (e) {
          return sendError(res, 500, 'Could not save the order: ' + e.message);
        }
        if (result.error) return sendError(res, result.status, result.error);
        sendJson(res, result.status, result.order);
      },
      (e) => sendError(res, 400, e.message),
    );
    return;
  }

  // PATCH /api/orders/:id/status
  if (req.method === 'PATCH' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'orders' && parts[3] === 'status') {
    const id = decodeURIComponent(parts[2]);
    readBody(req).then(
      (body) => {
        const status = asNonEmptyString(body.status);
        if (!ALLOWED_STATUSES.includes(status)) {
          return sendError(res, 400,
            `status must be one of: ${ALLOWED_STATUSES.join(', ')}.`);
        }
        const orders = loadOrders();
        const order = orders.find((o) => o.id === id || o.order_number === id);
        if (!order) return sendError(res, 404, `No order found with id ${id}.`);
        order.status = status;
        order.updated_at = new Date().toISOString();
        try {
          saveOrders(orders);
        } catch (e) {
          return sendError(res, 500, 'Could not save the order: ' + e.message);
        }
        sendJson(res, 200, order);
      },
      (e) => sendError(res, 400, e.message),
    );
    return;
  }

  sendError(res, 404, `No such route: ${req.method} ${url.pathname}.`);
}

// ------------------------------------------------------------------ main ---

ensureDataFiles();
loadMenu();

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    // Never crash the server on a bad request.
    if (!res.headersSent) sendError(res, 500, 'Server error: ' + e.message);
    console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`Pizza Club online ordering backend listening on http://localhost:${PORT}`);
  console.log(`Menu: ${menu.products.length} products in ${menu.categories.length} categories`);
  console.log(`Data: ${DATA_DIR}`);
});
