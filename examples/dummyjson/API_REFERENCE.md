# DummyJSON API Reference

> This is a compact reference designed for AI agents (Cursor, Claude Code, Codex).
> Full docs: https://dummyjson.com/docs

Base URL: `https://dummyjson.com`

---

## Global Query Parameters (all list endpoints)

| Param    | Example               | Effect                                             |
| -------- | --------------------- | -------------------------------------------------- |
| `limit`  | `?limit=10`           | Items per page (default 30, `0` = all)             |
| `skip`   | `?skip=20`            | Skip N items                                       |
| `select` | `?select=title,price` | Return only selected fields (`id` always included) |
| `sortBy` | `?sortBy=price`       | Sort by field name                                 |
| `order`  | `?order=asc`          | Sort direction: `asc` or `desc`                    |
| `delay`  | `?delay=3000`         | Simulate latency (0-5000 ms)                       |

All list responses share this envelope:

```json
{ "<resource>": [...], "total": 194, "skip": 0, "limit": 30 }
```

---

## Authentication

### Login

```
POST /auth/login
Content-Type: application/json

{ "username": "emilys", "password": "emilyspass" }
```

Response:

```json
{
  "id": 1,
  "username": "emilys",
  "email": "emily.johnson@x.dummyjson.com",
  "firstName": "Emily",
  "lastName": "Johnson",
  "gender": "female",
  "image": "https://dummyjson.com/icon/emilys/128",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Get Current User (protected)

```
GET /auth/me
Authorization: Bearer <accessToken>
```

Response: full user object (same fields as `/users/:id`).

### Refresh Token

```
POST /auth/refresh
Content-Type: application/json

{ "refreshToken": "<refreshToken>", "expiresInMins": 30 }
```

Response: `{ "accessToken": "...", "refreshToken": "..." }`

### Access Any Resource as Authenticated User

```
GET /auth/products        (same as /products, but requires Bearer token)
GET /auth/carts           (same as /carts, but requires Bearer token)
```

---

## Products (194 total)

### Endpoints

| Method | Path                       | Description                             |
| ------ | -------------------------- | --------------------------------------- |
| GET    | `/products`                | List all (paginated)                    |
| GET    | `/products/:id`            | Get by ID                               |
| GET    | `/products/search?q=phone` | Search by title/description             |
| GET    | `/products/categories`     | List categories `[{ slug, name, url }]` |
| GET    | `/products/category-list`  | List category slugs `["beauty", ...]`   |
| GET    | `/products/category/:slug` | Products by category                    |
| POST   | `/products/add`            | Create (simulated)                      |
| PUT    | `/products/:id`            | Update (simulated)                      |
| DELETE | `/products/:id`            | Delete (simulated)                      |

### Product Object

```json
{
  "id": 1,
  "title": "Essence Mascara Lash Princess",
  "description": "The Essence Mascara Lash Princess is a popular mascara...",
  "category": "beauty",
  "price": 9.99,
  "discountPercentage": 10.48,
  "rating": 2.56,
  "stock": 99,
  "tags": ["beauty", "mascara"],
  "brand": "Essence",
  "sku": "BEA-ESS-ESS-001",
  "weight": 4,
  "dimensions": { "width": 15.14, "height": 13.08, "depth": 22.99 },
  "warrantyInformation": "1 week warranty",
  "shippingInformation": "Ships in 3-5 business days",
  "availabilityStatus": "In Stock",
  "reviews": [
    {
      "rating": 3,
      "comment": "Would not recommend!",
      "date": "2025-04-30T09:41:02.053Z",
      "reviewerName": "Eleanor Collins",
      "reviewerEmail": "eleanor.collins@x.dummyjson.com"
    }
  ],
  "returnPolicy": "30 days return policy",
  "minimumOrderQuantity": 24,
  "meta": {
    "createdAt": "2025-04-30T09:41:02.053Z",
    "updatedAt": "2025-04-30T09:41:02.053Z",
    "barcode": "9164035109868",
    "qrCode": "https://dummyjson.com/public/qr-code.png"
  },
  "thumbnail": "https://cdn.dummyjson.com/products/images/beauty/...",
  "images": ["https://cdn.dummyjson.com/products/images/beauty/..."]
}
```

### CRUD Notes

- **POST /products/add**: returns new product with `id: 195` (not persisted to server).
- **PUT /products/:id**: returns merged product. Send only fields to update.
- **DELETE /products/:id**: returns product with added `"isDeleted": true, "deletedOn": "<ISO8601>"`.

---

## Users (208 total)

### Endpoints

| Method | Path                                       | Description                                   |
| ------ | ------------------------------------------ | --------------------------------------------- |
| GET    | `/users`                                   | List all (paginated)                          |
| GET    | `/users/:id`                               | Get by ID                                     |
| GET    | `/users/search?q=John`                     | Search by name/email                          |
| GET    | `/users/filter?key=hair.color&value=Brown` | Filter by any field (dot-notation for nested) |
| GET    | `/users/:id/carts`                         | User's carts                                  |
| GET    | `/users/:id/posts`                         | User's posts                                  |
| GET    | `/users/:id/todos`                         | User's todos                                  |
| POST   | `/users/add`                               | Create (simulated)                            |
| PUT    | `/users/:id`                               | Update (simulated)                            |
| DELETE | `/users/:id`                               | Delete (simulated)                            |

### User Object (key fields)

```json
{
  "id": 1,
  "firstName": "Emily",
  "lastName": "Johnson",
  "maidenName": "Smith",
  "age": 29,
  "gender": "female",
  "email": "emily.johnson@x.dummyjson.com",
  "phone": "+81 965-431-3024",
  "username": "emilys",
  "password": "emilyspass",
  "birthDate": "1996-5-30",
  "image": "https://dummyjson.com/icon/emilys/128",
  "bloodGroup": "O-",
  "height": 193.24,
  "weight": 63.16,
  "eyeColor": "Green",
  "hair": { "color": "Brown", "type": "Curly" },
  "address": {
    "address": "626 Main Street",
    "city": "Phoenix",
    "state": "Mississippi",
    "stateCode": "MS",
    "postalCode": "29112",
    "coordinates": { "lat": -77.16213, "lng": -92.084824 },
    "country": "United States"
  },
  "university": "University of Wisconsin--Madison",
  "bank": {
    "cardExpire": "05/28",
    "cardNumber": "3693233511855044",
    "cardType": "Diners Club International",
    "currency": "GBP",
    "iban": "GB74MH2UZLR9TRPHYNU8F8"
  },
  "company": {
    "department": "Engineering",
    "name": "Dooley, Kozey and Cronin",
    "title": "Sales Manager",
    "address": {
      "address": "...",
      "city": "San Francisco",
      "state": "Wisconsin"
    }
  },
  "role": "admin",
  "crypto": {
    "coin": "Bitcoin",
    "wallet": "0xb9fc...",
    "network": "Ethereum (ERC20)"
  }
}
```

### Filter Examples

```
GET /users/filter?key=hair.color&value=Brown       → 23 users
GET /users/filter?key=gender&value=male             → ~104 users
GET /users/filter?key=role&value=admin               → admin users
GET /users/filter?key=company.department&value=Engineering
```

---

## Carts (50 total)

### Endpoints

| Method | Path                  | Description                                   |
| ------ | --------------------- | --------------------------------------------- |
| GET    | `/carts`              | List all (paginated)                          |
| GET    | `/carts/:id`          | Get by ID                                     |
| GET    | `/carts/user/:userId` | Get carts by user                             |
| POST   | `/carts/add`          | Create cart                                   |
| PUT    | `/carts/:id`          | Update cart (`merge: true` to keep old items) |
| DELETE | `/carts/:id`          | Delete (simulated)                            |

### Cart Object

```json
{
  "id": 1,
  "userId": 142,
  "total": 4794.8,
  "discountedTotal": 4288.95,
  "totalProducts": 5,
  "totalQuantity": 20,
  "products": [
    {
      "id": 168,
      "title": "Charger SXT RWD",
      "price": 32999.99,
      "quantity": 3,
      "total": 98999.97,
      "discountPercentage": 13.39,
      "discountedTotal": 85743.87,
      "thumbnail": "https://cdn.dummyjson.com/products/images/..."
    }
  ]
}
```

### Create Cart

```
POST /carts/add
{ "userId": 1, "products": [{ "id": 144, "quantity": 4 }, { "id": 98, "quantity": 1 }] }
```

Response includes auto-calculated `total`, `discountedTotal`, `totalQuantity`.

### Update Cart

```
PUT /carts/1
{ "merge": true, "products": [{ "id": 1, "quantity": 1 }] }
```

`merge: true` keeps existing products and adds/updates the new ones.

---

## Recipes (50 total)

### Endpoints

| Method | Path                           | Description                                |
| ------ | ------------------------------ | ------------------------------------------ |
| GET    | `/recipes`                     | List all (paginated)                       |
| GET    | `/recipes/:id`                 | Get by ID                                  |
| GET    | `/recipes/search?q=Margherita` | Search by name                             |
| GET    | `/recipes/tags`                | List all tags `["Pizza", "Italian", ...]`  |
| GET    | `/recipes/tag/:tagName`        | Recipes by tag                             |
| GET    | `/recipes/meal-type/:type`     | Recipes by meal type (Snack, Dinner, etc.) |
| POST   | `/recipes/add`                 | Create (simulated)                         |
| PUT    | `/recipes/:id`                 | Update (simulated)                         |
| DELETE | `/recipes/:id`                 | Delete (simulated)                         |

### Recipe Object

```json
{
  "id": 1,
  "name": "Classic Margherita Pizza",
  "ingredients": [
    "Pizza dough",
    "Tomato sauce",
    "Fresh mozzarella cheese",
    "..."
  ],
  "instructions": [
    "Preheat the oven to 475F...",
    "Roll out the pizza dough...",
    "..."
  ],
  "prepTimeMinutes": 20,
  "cookTimeMinutes": 15,
  "servings": 4,
  "difficulty": "Easy",
  "cuisine": "Italian",
  "caloriesPerServing": 300,
  "tags": ["Pizza", "Italian"],
  "userId": 166,
  "image": "https://cdn.dummyjson.com/recipe-images/1.webp",
  "rating": 4.6,
  "reviewCount": 98,
  "mealType": ["Dinner"]
}
```

---

## Test Credentials

| Username   | Password       | Role  |
| ---------- | -------------- | ----- |
| `emilys`   | `emilyspass`   | admin |
| `michaelw` | `michaelwpass` | user  |

Full user list available at `GET /users?select=username,password,role&limit=0`.

---

## Error Responses

**Invalid auth (401):**

```json
{ "message": "Authentication Problem", "... }
```

**Not found (404):**

```json
{ "message": "Product with id '9999' not found" }
```

**Invalid login (400):**

```json
{ "message": "Invalid credentials" }
```

---

## Notes for AI Agents

- All CRUD mutations (POST/PUT/DELETE) are **simulated** — they return realistic responses but don't persist data on the server.
- The `select` query param always includes `id` even if not requested.
- Pagination response always includes `total`, `skip`, and `limit` fields.
- The `delay` param (0-5000ms) can be used to test timeout handling.
- Nested filter key uses dot-notation: `key=hair.color&value=Brown`.
- The `?q=` search param searches across multiple text fields (name, title, description, etc.).
