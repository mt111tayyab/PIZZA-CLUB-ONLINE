/* Pizza Club Pindi Gheb — online ordering (no framework, no CDN).
 * Menu comes from the backend API when reachable; if the API is down,
 * browsing falls back to the embedded menu.json in this folder and
 * ordering is disabled with a clear message (the real error is shown).
 * config.js must define API_BASE_URL before this file loads.
 */
'use strict';

const API_BASE = (typeof API_BASE_URL === 'string' && API_BASE_URL)
  ? API_BASE_URL.replace(/\/+$/, '')
  : 'http://localhost:3001';

const STATUS_STEPS = [
  ['received', 'Order received'],
  ['accepted', 'Accepted by the restaurant'],
  ['preparing', 'Preparing'],
  ['ready', 'Ready'],
  ['out_for_delivery', 'Out for delivery'],
  ['delivered', 'Delivered'],
  ['completed', 'Completed'],

];

let menu = null;          // { note, categories, products }
let apiOnline = false;    // true only when the live API answered
let apiError = '';        // the real error text, shown to the user
let cart = [];            // {product_id, product_name, size_name, addons[], qty, unit_price_paisa}
let currentProduct = null;
let dlgSize = '';
let dlgQty = 1;

const $ = (id) => document.getElementById(id);

function rs(paisa) {
  return 'Rs ' + (paisa / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function apiUrl(path) {
  return API_BASE + path;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ('HTTP ' + res.status + ' ' + res.statusText);
    throw new Error(msg);
  }
  return data;
}

/* ------------------------------------------------------------ menu --- */

async function loadMenu() {
  try {
    const data = await fetchJson(apiUrl('/api/menu'));
    if (!data || !Array.isArray(data.products)) throw new Error('Menu from the server was not in the expected format.');
    menu = data;
    apiOnline = true;
    apiError = '';
  } catch (e) {
    apiOnline = false;
    apiError = e && e.message ? e.message : String(e);
    // Fall back to the embedded menu so customers can still browse.
    try {
      const res = await fetch('menu.json');
      if (!res.ok) throw new Error('menu.json could not be loaded (' + res.status + ').');
      menu = await res.json();
    } catch (e2) {
      $('menu').innerHTML = '<p class="empty">The menu could not be loaded. '
        + 'Online ordering is unavailable right now (' + esc(apiError) + '). '
        + 'Please call the restaurant: 0316 4382148 / 0304 8694489.</p>';
      updateApiBanner();
      return;
    }
  }
  updateApiBanner();
  populateCategoryFilter();
  renderMenu();
  if (menu.note) $('menu-note').textContent = menu.note;
}

function updateApiBanner() {
  const banner = $('api-banner');
  if (apiOnline) {
    banner.textContent = 'Online ordering is live — your order goes straight to the restaurant kitchen.';
    banner.classList.add('online');
    banner.classList.remove('hidden');
  } else {
    banner.textContent = 'Online ordering is unavailable right now (' + apiError + '). '
      + 'You can still browse the menu below, but orders cannot be placed until the backend is back. '
      + 'To order now, please call 0316 4382148 / 0304 8694489.';
    banner.classList.remove('online');
    banner.classList.remove('hidden');
  }
}

function populateCategoryFilter() {
  const select = $('category-filter');
  select.querySelectorAll('option:not([value=""])').forEach((o) => o.remove());
  for (const c of menu.categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
}

function productBasePrice(p) {
  return p.price_paisa;
}

function renderMenu() {
  const query = $('search').value.trim().toLowerCase();
  const catFilter = $('category-filter').value;
  const box = $('menu');
  box.innerHTML = '';

  const visible = menu.products.filter((p) => {
    if (catFilter && p.category_id !== catFilter) return false;
    if (query && !(p.name.toLowerCase().includes(query) ||
        (p.description || '').toLowerCase().includes(query))) return false;
    return true;
  });

  if (visible.length === 0) {
    box.innerHTML = '<p class="empty">No items match your search. Try a different word or category.</p>';
    return;
  }

  for (const cat of menu.categories) {
    const items = visible.filter((p) => p.category_id === cat.id);
    if (items.length === 0) continue;
    const h = document.createElement('h2');
    h.textContent = cat.name;
    box.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'cards';
    for (const p of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.innerHTML =
        '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<span class="card-body"><h3>' + esc(p.name) + '</h3>' +
        '<p>' + esc(p.description || '') + '</p>' +
        '<span class="card-foot"><span class="price">' + esc(rs(productBasePrice(p))) +
        (p.has_sizes ? ' <small>(Regular)</small>' : '') + '</span>' +
        '<span class="btn btn-yellow">Add</span></span></span>';
      card.addEventListener('click', () => openProductDialog(p));
      grid.appendChild(card);
    }
    box.appendChild(grid);
  }
}

/* --------------------------------------------------- product dialog --- */

function sizePrice(p, sizeName) {
  if (!sizeName) return p.price_paisa;
  const size = (p.sizes || []).find((s) => s.name === sizeName);
  return size ? size.price_paisa : p.price_paisa;
}

function addonPrice(p, name) {
  const a = (p.addons || []).find((x) => x.name === name);
  return a ? a.price_paisa : 0;
}

function selectedAddons() {
  return Array.from(document.querySelectorAll('#dlg-addon-list input:checked'))
    .map((el) => el.value);
}

function dlgUnitPrice() {
  if (!currentProduct) return 0;
  let unit = sizePrice(currentProduct, dlgSize);
  for (const name of selectedAddons()) unit += addonPrice(currentProduct, name);
  return unit;
}

function refreshDlgPrice() {
  $('dlg-price').textContent = rs(dlgUnitPrice() * dlgQty);
}

function openProductDialog(p) {
  currentProduct = p;
  dlgQty = 1;
  $('dlg-qty-input').value = '1';
  $('dlg-img').src = p.image;
  $('dlg-img').alt = p.name;
  $('dlg-name').textContent = p.name;
  $('dlg-desc').textContent = p.description || '';

  const sizesBox = $('dlg-sizes');
  sizesBox.innerHTML = '';
  if (p.has_sizes && p.sizes && p.sizes.length) {
    dlgSize = 'Regular';
    for (const s of p.sizes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'size-pill' + (s.name === dlgSize ? ' selected' : '');
      b.textContent = s.name + ' — ' + rs(s.price_paisa);
      b.addEventListener('click', () => {
        dlgSize = s.name;
        sizesBox.querySelectorAll('.size-pill').forEach((el) => el.classList.remove('selected'));
        b.classList.add('selected');
        refreshDlgPrice();
      });
      sizesBox.appendChild(b);
    }
  } else {
    dlgSize = '';
  }

  const addonsBox = $('dlg-addon-list');
  addonsBox.innerHTML = '';
  $('dlg-addons').style.display = (p.addons && p.addons.length) ? '' : 'none';
  for (const a of (p.addons || [])) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = a.name;
    cb.addEventListener('change', refreshDlgPrice);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + a.name + ' (+' + rs(a.price_paisa) + ')'));
    addonsBox.appendChild(label);
  }

  refreshDlgPrice();
  $('product-dialog').showModal();
}

function addCurrentToCart() {
  if (!currentProduct) return;
  const addons = selectedAddons();
  const unit = dlgUnitPrice();
  const key = currentProduct.id + '|' + dlgSize + '|' + addons.join(',');
  const existing = cart.find((c) => c.key === key);
  if (existing) {
    existing.qty += dlgQty;
  } else {
    cart.push({
      key,
      product_id: currentProduct.id,
      product_name: currentProduct.name,
      size_name: dlgSize,
      addons,
      qty: dlgQty,
      unit_price_paisa: unit,
    });
  }
  saveCart();
  renderCart();
  $('product-dialog').close();
}

/* ------------------------------------------------------------- cart --- */

function cartSubtotal() {
  return cart.reduce((s, c) => s + c.unit_price_paisa * c.qty, 0);
}

function saveCart() {
  try { localStorage.setItem('pizza_club_cart', JSON.stringify(cart)); } catch (_) { /* private mode */ }
}

function loadCart() {
  try {
    const raw = localStorage.getItem('pizza_club_cart');
    if (raw) cart = JSON.parse(raw) || [];
  } catch (_) { cart = []; }
}

function renderCart() {
  const count = cart.reduce((s, c) => s + c.qty, 0);
  $('cart-count').textContent = String(count);

  const box = $('cart-items');
  box.innerHTML = '';
  if (cart.length === 0) {
    box.innerHTML = '<p class="empty-cart">Your cart is empty. Pick something tasty from the menu.</p>';
  }
  for (const item of cart) {
    const line = document.createElement('div');
    line.className = 'cart-line';
    const detail = [item.size_name, item.addons.join(', ')].filter(Boolean).join(' • ');
    line.innerHTML =
      '<div class="info"><strong>' + esc(item.product_name) + '</strong>' +
      (detail ? '<small>' + esc(detail) + '</small>' : '') +
      '<small>' + esc(rs(item.unit_price_paisa)) + ' each</small></div>' +
      '<div class="qty-controls">' +
      '<button type="button" data-act="minus" aria-label="Decrease quantity">−</button>' +
      '<span>' + item.qty + '</span>' +
      '<button type="button" data-act="plus" aria-label="Increase quantity">+</button>' +
      '</div>' +
      '<strong>' + esc(rs(item.unit_price_paisa * item.qty)) + '</strong>' +
      '<button type="button" data-act="remove" aria-label="Remove item">✕</button>';
    line.querySelector('[data-act="minus"]').addEventListener('click', () => {
      item.qty -= 1;
      if (item.qty <= 0) cart = cart.filter((c) => c !== item);
      saveCart(); renderCart();
    });
    line.querySelector('[data-act="plus"]').addEventListener('click', () => {
      item.qty += 1;
      saveCart(); renderCart();
    });
    line.querySelector('[data-act="remove"]').addEventListener('click', () => {
      cart = cart.filter((c) => c !== item);
      saveCart(); renderCart();
    });
    box.appendChild(line);
  }

  const subtotal = cartSubtotal();
  $('cart-summary').innerHTML =
    '<div class="row"><span>Subtotal</span><span>' + esc(rs(subtotal)) + '</span></div>' +
    '<div class="row"><span>Delivery</span><span>FREE</span></div>' +
    '<div class="row total"><span>Total</span><span>' + esc(rs(subtotal)) + '</span></div>';

  // Ordering state: disabled when the API is unreachable.
  const disabled = $('checkout-disabled');
  const form = $('checkout-form');
  const submit = form.querySelector('button[type="submit"]');
  if (!apiOnline) {
    disabled.classList.remove('hidden');
    disabled.textContent = 'Ordering is disabled right now — the restaurant backend could not be reached (' + apiError + '). '
      + 'Please try again later or call 0316 4382148 / 0304 8694489.';
    submit.disabled = true;
  } else {
    disabled.classList.add('hidden');
    submit.disabled = cart.length === 0;
  }
  $('confirmation').classList.add('hidden');
  form.classList.remove('hidden');
}

/* --------------------------------------------------------- checkout --- */

async function placeOrder(event) {
  event.preventDefault();
  const err = $('checkout-error');
  err.textContent = '';

  if (!apiOnline) {
    err.textContent = 'Ordering is unavailable — the backend could not be reached (' + apiError + ').';
    return;
  }
  if (cart.length === 0) {
    err.textContent = 'Your cart is empty.';
    return;
  }
  const name = $('co-name').value.trim();
  const phone = $('co-phone').value.trim();
  if (!name) { err.textContent = 'Please enter your name.'; return; }
  if (phone.length < 10) { err.textContent = 'Please enter a phone number of at least 10 digits.'; return; }
  const type = $('co-type').value;
  if (type === 'delivery' && !$('co-address').value.trim()) {
    err.textContent = 'Please enter a delivery address.';
    return;
  }

  const payload = {
    customer_name: name,
    customer_phone: phone,
    address: $('co-address').value.trim(),
    instructions: $('co-instructions').value.trim(),
    type,
    payment_method: $('co-payment').value,
    items: cart.map((c) => ({
      product_id: c.product_id,
      size_name: c.size_name || undefined,
      addons: c.addons,
      qty: c.qty,
    })),
  };

  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'Placing order…';
  try {
    const order = await fetchJson(apiUrl('/api/orders'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    cart = [];
    saveCart();
    renderCart();
    $('checkout-form').classList.add('hidden');
    const conf = $('confirmation');
    conf.classList.remove('hidden');
    conf.innerHTML =
      '<h3>Order placed — thank you!</h3>' +
      '<p>Your order number is</p>' +
      '<p class="order-no">' + esc(order.order_number) + '</p>' +
      '<p>Total: <strong>' + esc(rs(order.total_paisa)) + '</strong> • ' + esc(order.payment_method) + '</p>' +
      '<p>Track it below with your order number, or call 0316 4382148 with any change.</p>' +
      '<button type="button" class="btn btn-yellow" id="conf-track">Track this order</button>';
    $('conf-track').addEventListener('click', () => {
      $('cart-dialog').close();
      $('track-number').value = order.order_number;
      trackOrder(order.order_number);
      document.getElementById('track').scrollIntoView({ behavior: 'smooth' });
    });
  } catch (e) {
    err.textContent = 'Could not place the order: ' + (e && e.message ? e.message : String(e));
  } finally {
    submit.disabled = false;
    submit.textContent = 'Place order';
  }
}

/* ------------------------------------------------------------ track --- */

function timelineHtml(status) {
  if (status === 'cancelled' || status === 'rejected') {
    return '<ul class="timeline"><li class="cancelled">Order ' + esc(status) + '</li></ul>'
      + '<p>This order was ' + esc(status) + '. If this is a mistake, please call 0316 4382148.</p>';
  }
  const idx = STATUS_STEPS.findIndex(([s]) => s === status);
  const current = idx < 0 ? 0 : idx;
  let html = '<ul class="timeline">';
  STATUS_STEPS.forEach(([s, label], i) => {
    const cls = i < current ? 'done' : (i === current ? 'current' : '');
    html += '<li class="' + cls + '">' + esc(label) + '</li>';
  });
  html += '</ul>';
  return html;
}

/* v2.0.5: the track page used to fetch once and never refresh, so
   even after the restaurant accepted the order the page stayed on
   "Order received" until the customer re-typed the number. Now the
   tracked order is re-fetched quietly every 30 seconds. */
let trackedNumber = '';
let trackTimer = null;

async function trackOrder(number, quiet) {
  const box = $('track-result');
  number = (number || '').trim();
  if (!number) { box.innerHTML = '<p>Enter an order number first.</p>'; return; }
  if (!quiet) box.innerHTML = '<p>Looking up ' + esc(number) + '…</p>';
  try {
    const order = await fetchJson(apiUrl('/api/orders/' + encodeURIComponent(number)));
    box.innerHTML =
      '<p><strong>' + esc(order.order_number) + '</strong> — ' + esc(order.customer_name) +
      ' • ' + esc(rs(order.total_paisa)) + ' • ' + esc(order.type) + ' • ' + esc(order.payment_method) + '</p>' +
      timelineHtml(order.status);
    // Keep this order live: refresh quietly every 30 seconds.
    if (trackedNumber !== number) {
      trackedNumber = number;
      if (trackTimer) clearInterval(trackTimer);
      trackTimer = setInterval(() => trackOrder(trackedNumber, true), 30000);
    }
  } catch (e) {
    if (quiet) return; // background refresh failed: keep the last shown status.
    const msg = e && e.message ? e.message : String(e);
    box.innerHTML = '<p>Could not find that order (' + esc(msg) + '). '
      + 'Check the number and try again — it looks like PC-ONLINE-0001.</p>';
  }
}

/* ------------------------------------------------------------- init --- */

$('search').addEventListener('input', renderMenu);
$('category-filter').addEventListener('change', renderMenu);
$('cart-button').addEventListener('click', () => {
  renderCart();
  $('cart-dialog').showModal();
});
$('dlg-qty-minus').addEventListener('click', () => {
  dlgQty = Math.max(1, dlgQty - 1);
  $('dlg-qty-input').value = String(dlgQty);
  refreshDlgPrice();
});
$('dlg-qty-plus').addEventListener('click', () => {
  dlgQty = Math.min(20, dlgQty + 1);
  $('dlg-qty-input').value = String(dlgQty);
  refreshDlgPrice();
});
$('dlg-qty-input').addEventListener('change', () => {
  const v = parseInt($('dlg-qty-input').value, 10);
  dlgQty = Number.isFinite(v) ? Math.min(20, Math.max(1, v)) : 1;
  $('dlg-qty-input').value = String(dlgQty);
  refreshDlgPrice();
});
$('dlg-add').addEventListener('click', addCurrentToCart);
$('checkout-form').addEventListener('submit', placeOrder);
$('track-form').addEventListener('submit', (e) => {
  e.preventDefault();
  trackOrder($('track-number').value);
});

loadCart();
renderCart();
loadMenu();
