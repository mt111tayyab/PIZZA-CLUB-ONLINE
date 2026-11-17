# Pizza Club Pindi Gheb — Online Ordering Backend (v2.0.0)

Local/demo backend for online orders. **Node.js standard library only — zero
npm dependencies, nothing to install.**

## Run

```bash
node backend/server.js
# or: npm start   (from backend/)
```

Listens on port **3001** by default; override with the `PORT` env var:

```bash
PORT=8080 node backend/server.js
```

On first run it creates `backend/data/` if needed and starts `orders.json`
as an empty array. `menu.json` must already exist there — it is generated
from the Flutter seed data (`lib/data/seed_data.dart`, 12 categories /
64 products, placeholder PKR prices) and is **not** hand-written.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/menu` | `{ note, categories, products }` — prices in paisa + Rs, sizes for pizzas, add-ons |
| POST | `/api/orders` | Create an order. Prices are looked up from the menu, never trusted from the client. Returns the order (201) or `{ error }` (400) |
| GET | `/api/orders` | All orders (newest last, as stored) |
| GET | `/api/orders/:id` | One order — `:id` may be the order `id` **or** the `PC-ONLINE-xxxx` order number, so customers can track by the number on their confirmation |
| PATCH | `/api/orders/:id/status` | Body `{ "status": "..." }`. Allowed: `received`, `accepted`, `preparing`, `ready`, `out_for_delivery`, `delivered`, `completed`, `cancelled`, `rejected`. 404 if the order does not exist |

Order numbers are assigned in sequence: `PC-ONLINE-0001`, `PC-ONLINE-0002`, …
New orders start with status `received`. Delivery is free (the restaurant
advertises FREE DELIVERY), so `delivery_fee_paisa` is 0 and there are no
discount codes in v2.0.0.

POST validation (400 with `{ "error": "..." }` on failure):

- `customer_name` non-empty
- `customer_phone` at least 10 characters
- `items` a non-empty array; each item needs a known `product_id` and
  `qty >= 1`; `size_name` and `addons` (names) must exist on that product

## Data files (`backend/data/`)

- `menu.json` — the menu (seeded from the Flutter app; edit prices here and
  restart the server to change them — the Flutter app's own menu is separate)
- `orders.json` — every order, persisted on every create/status change
  (written via a temp file + rename, so a crash cannot half-write it)

## CORS

`Access-Control-Allow-Origin: *` on every response, and `OPTIONS`
preflight requests are answered, so the static `online-web/` site can call
this backend from any origin (including `file://` via a local server).

## Honest note — read before hosting this

This is a **local file-store backend, not a hosted/production backend**.
It has no authentication (anyone who can reach it can read orders and
change their status), no rate limiting, no HTTPS of its own, and stores
everything in two JSON files. That is fine for testing on the restaurant's
own computer or a small trusted host. Do **not** expose it to the open
internet as-is, and do not claim it is production-hardened. Before any
public hosting it needs auth, HTTPS, a real database, and backups.
