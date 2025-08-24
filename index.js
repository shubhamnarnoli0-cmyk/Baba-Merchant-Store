const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

const app = express();
const port = process.env.PORT || 3001;
const path = require('path');


const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const allowedOrigins = [
  'https://baba-merchant-store.onrender.com',
  'http://localhost:3001',
  'http://localhost:8080',
  'http://10.0.2.2:3001',
  'http://10.0.2.2:8080',
  'https://baba-merchant-frontend.onrender.com'
];

app.use(cookieParser()); // if not already present




app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy: This origin is not allowed'));
    }
  },
  credentials: true
}));



app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// GET /api/products
app.get('/api/products', async (req, res) => {
const { company_id } = req.query;
  try {
    if (company_id) {
      result = await pool.query(
        'SELECT id, name, price, image_url, base_price, min_retail_price FROM products WHERE company_id = $1',
        [company_id]
      );
    } else {
      result = await pool.query('SELECT id, name, price, image_url, min_retail_price FROM products');
    }
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Database error' });
  }
});


const bcrypt = require('bcrypt');

// SIGN UP
app.post('/api/signup', async (req, res) => {
  const { customer_id, password, name, email, phone } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO customers (customer_id, password, name, email, phone) VALUES ($1, $2, $3, $4, $5)',
      [customer_id, hashedPassword, name, email, phone]
    );
    res.json({ message: 'Account created successfully' });
  } catch (err) {
    console.error('Error creating account:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { customer_id, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM customers WHERE customer_id = $1',
      [customer_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }


    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password);

    if (match) {
      res.json({ message: 'Login successful',customer_id, name: user.name });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// RESET PASSWORD
app.post('/api/reset', async (req, res) => {
  const { customer_id, new_password } = req.body;

  try {
    const hash = await bcrypt.hash(new_password, 10);
    const update = await pool.query(
      'UPDATE customers SET password = $1 WHERE customer_id = $2',
      [hash, customer_id]
    );

    if (update.rowCount === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/order-history
app.get('/api/order-history', async (req, res) => {
  const customer_id = req.query.customer_id;

  if (!customer_id) {
    return res.status(400).json({ error: "Missing customer_id" });
  }

  try {
    const result = await pool.query(`
      SELECT o.id AS order_id, o.created_at, p.name, oi.quantity, oi.unit_price, o.status
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC
    `, [customer_id]);

    // Group items by order_id
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.order_id]) {
        grouped[row.order_id] = {
          order_id: row.order_id,
          created_at: row.created_at,
          items: [],
          total: 0
        };
      }

      const itemTotal = parseFloat(row.unit_price) * row.quantity;
      grouped[row.order_id].items.push({
        name: row.name,
        quantity: row.quantity,
        unit_price: row.unit_price,
        total: itemTotal
      });

      grouped[row.order_id].total += itemTotal;
    }

    res.json(Object.values(grouped));
  } catch (err) {
    console.error('Error fetching order history:', err);
    res.status(500).json({ error: "Failed to fetch order history" });
  }
});



app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// Get full order history with customer info and item names
app.get('/api/orders', async (req, res) => {
  try {
    const client = await pool.connect();
    const ordersRes = await client.query('SELECT * FROM orders ORDER BY created_at DESC');

    const orders = [];
    for (let order of ordersRes.rows) {
      const itemsRes = await client.query(`
        SELECT p.name, oi.quantity FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
      `, [order.id]);

      orders.push({
        ...order,
        items: itemsRes.rows
      });
    }

    client.release();
    res.json(orders);
  } catch (err) {
    console.error('Failed to fetch orders:', err);
    res.status(500).json({ error: 'Unable to fetch order history' });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  const { customer_ids, status, start_date, end_date } = req.query;
  try {
    const client = await pool.connect();

    let query = `
      SELECT 
        o.id AS order_id,
        o.customer_id,
        c.name AS customer_name,
        o.created_at,
        o.notes,
        o.status
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
    `;
    const conditions = [];
    const values = [];

    // Add filter for customer_ids (comma-separated string)
    if (customer_ids) {
      const ids = customer_ids.split(',');
      conditions.push(`o.customer_id = ANY($${values.length + 1})`);
      values.push(ids);
    }

    // Add filter for status
    if (status) {
      conditions.push(`o.status = $${values.length + 1}`);
      values.push(status);
    }
if (start_date) {
  values.push(start_date);
  conditions.push(`o.created_at >= $${values.length}`);
}

if (end_date) {
  values.push(end_date);
  conditions.push(`o.created_at <= $${values.length}`);
}


    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY o.created_at DESC";

    const orderResult = await client.query(query, values);

    const orders = [];

    for (let order of orderResult.rows) {
      const itemsResult = await client.query(`
        SELECT 
          oi.id AS order_item_id,
          p.name AS product_name,
          oi.quantity,
          oi.unit_price,
          oi.negotiated_price,
          p.base_price
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = $1
      `, [order.order_id]);

      const total_value = itemsResult.rows.reduce(
        (sum, item) => sum + item.negotiated_price * item.quantity,
        0
      );

      orders.push({
        ...order,
        items: itemsResult.rows,
        total_value
      });
    }

    client.release();
    res.json(orders);
  } catch (err) {
    console.error("Error fetching admin orders:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// PATCH negotiated_price for a specific order item
app.patch("/api/admin/orders/:orderId/items/:productId", async (req, res) => {
  const { orderId, productId } = req.params;
  const { negotiated_price } = req.body;

  if (negotiated_price === undefined || isNaN(negotiated_price)) {
    return res.status(400).json({ error: "Invalid negotiated_price value" });
  }

  try {
    const result = await pool.query(
      `UPDATE order_items 
       SET negotiated_price = $1 
       WHERE order_id = $2 AND product_id = $3`,
      [negotiated_price, orderId, productId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Order item not found" });
    }

    res.json({ message: "Final Price updated successfully" });
  } catch (err) {
    console.error("Error updating Final Price:", err);
    res.status(500).json({ error: "Failed to update Final Price" });
  }
});

app.get('/api/admin/products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id, 
        p.name, 
        p.base_price,
	p.min_retail_price, 
        p.image_url, p.hsn, p.cgst, p.sgst, p.cess,
        c.name AS company_name
      FROM products p
      JOIN companies c ON p.company_id = c.id
	WHERE p.is_active = TRUE
      ORDER BY p.name
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching admin products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// 🔹 Fetch a single product by ID (used in Edit Product modal)
app.get('/api/admin/products/:id', async (req, res) => {
  const productId = req.params.id;

  try {
    const result = await pool.query(`
SELECT 
  p.id, 
  p.name, 
  p.base_price, 
  p.min_retail_price,
  p.image_url, 
  p.company_id,     -- ✅ ADD THIS
  c.name AS company_name,
  p.hsn,
  p.cgst,
  p.sgst,
  p.cess
FROM products p
JOIN companies c ON p.company_id = c.id
WHERE p.id = $1
    `, [productId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});


app.post('/api/admin/products', async (req, res) => {
  const { name, image_url, company_id, base_price, min_retail_price, hsn, cgst, sgst, cess } = req.body;

  // Validate input
  if (!name || !base_price || !company_id || !hsn || !cgst || !sgst) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await pool.query(
      `INSERT INTO products (name, image_url, company_id, base_price, min_retail_price, hsn, cgst, sgst, cess)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [name, image_url, company_id, base_price, min_retail_price, hsn, cgst, sgst, cess]
    );

    res.json({ message: 'Product added successfully' });
  } catch (err) {
    console.error('Error adding product:', err);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

app.put('/api/admin/products/:id', async (req, res) => {
  const productId = parseInt(req.params.id);
  const { name, image_url, company_id, base_price, min_retail_price, hsn, cgst, sgst, cess } = req.body;

  console.log("Incoming PUT /api/admin/products/", productId, req.body); // ✅ Add this

  if (!name || !base_price || !company_id || !hsn || !cgst || !sgst) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const result = await pool.query(
      `UPDATE products SET name = $1, image_url = $2, company_id = $3, base_price = $4, min_retail_price = $5, hsn = $6, cgst = $7, sgst = $8, cess=$9 WHERE id = $10`,
      [name, image_url, company_id, base_price, min_retail_price, hsn, cgst, sgst, cess, productId]
    );

    console.log("Rows affected:", result.rowCount); // ✅ Log this too

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product updated successfully" });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.post("/api/admin/products/bulk", async (req, res) => {
  const { products } = req.body;
  console.log("Received products:", products);

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "No products provided" });
  }

  try {
    // Fetch all companies to map names to IDs
    const companiesRes = await pool.query("SELECT id, name FROM companies");
    const companyMap = {};
    companiesRes.rows.forEach(c => {
      companyMap[c.name.toLowerCase()] = c.id;
    });

const insertPromises = products.map(product => {
  const company_id = product.company_id;

  if (!company_id) {
    console.warn(`Skipping product due to missing company_id: ${product.name}`);
    return null;
  }

  console.log(`Inserting product: ${product.name}, company_id: ${company_id}`);

  return pool.query(
    `INSERT INTO products (name, price, base_price, image_url, company_id, is_active, min_retail_price, hsn, cgst, sgst, cess) VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, $10)`,
    [product.name, product.price, product.base_price, product.image_url, company_id, product.min_retail_price, product.hsn, product.cgst, product.sgst, product.cess]
  );
}).filter(Boolean); // Remove skipped entries

    await Promise.all(insertPromises);
    res.json({ message: "Bulk insert successful" });
  } catch (err) {
    console.error("Bulk insert error:", err);
    res.status(500).json({ error: "Failed to insert products" });
  }
});

app.delete('/api/admin/products/:id', async (req, res) => {
  const productId = req.params.id;

  try {
    const result = await pool.query(
      `UPDATE products SET is_active = FALSE WHERE id = $1`,
      [productId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});



app.get("/api/companies", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, logo_url FROM companies ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching companies:", err);
    res.status(500).json({ error: "Failed to fetch companies" });
  }
});

app.post('/api/place-order', async (req, res) => {
  const { customer_id, items } = req.body;

  if (!customer_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing customer_id or items' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert into orders table
    const orderRes = await client.query(
      'INSERT INTO orders (customer_id, created_at) VALUES ($1, NOW()) RETURNING id',
      [customer_id]
    );
    const orderId = orderRes.rows[0].id;

    // Insert each item into order_items
    for (const item of items) {
  const priceRes = await client.query(
    'SELECT price FROM products WHERE id = $1',
    [item.product_id]
  );

  const unit_price = priceRes.rows[0].price;
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price, negotiated_price) VALUES ($1, $2, $3, $4, $5)',
        [orderId, item.product_id, item.quantity, unit_price, item.negotiated_price]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Order placed successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error placing order:', err);
    res.status(500).json({ error: 'Order placement failed' });
  } finally {
    client.release();
  }
});
app.patch('/api/admin/orders/:id', async (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body;

  if (!['Pending', 'Fulfilled', 'Cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  try {
    const result = await pool.query(
      `UPDATE orders SET status = $1 WHERE id = $2`,
      [status, orderId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ message: 'Order status updated successfully' });
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});
app.get("/api/admin/customers", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT customer_id, name FROM customers ORDER BY name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching customers:", err);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

app.get('/api/admin/orders/:id', async (req, res) => {
  const orderId = parseInt(req.params.id);
  if (isNaN(orderId)) {
    return res.status(400).json({ error: "Invalid order ID" });
  }
  try {
    const orderResult = await pool.query(`
      SELECT o.id AS order_id, o.status, o.created_at, c.name AS customer_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
      WHERE o.id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemsResult = await pool.query(`
      SELECT p.id AS product_id, p.name AS product_name, oi.quantity, oi.negotiated_price, oi.unit_price
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [orderId]);

    res.json({
      ...orderResult.rows[0],
      items: itemsResult.rows
    });
  } catch (err) {
    console.error("Error fetching order:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.get('/api/admin/sales-summary', async (req, res) => {
  try {
    const client = await pool.connect();

    // Total orders
    const totalOrdersRes = await client.query(`SELECT COUNT(*) FROM orders`);
    const total_orders = parseInt(totalOrdersRes.rows[0].count);

    // Total revenue (only fulfilled orders)
    const revenueRes = await client.query(`
      SELECT SUM(oi.quantity * oi.unit_price) AS total_revenue
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      WHERE o.status = 'Fulfilled'
    `);
    const total_revenue = parseFloat(revenueRes.rows[0].total_revenue) || 0;

    // Total items sold (only fulfilled orders)
    const itemsRes = await client.query(`
      SELECT SUM(oi.quantity) AS total_items
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      WHERE o.status = 'Fulfilled'
    `);
    const total_items_sold = parseInt(itemsRes.rows[0].total_items) || 0;

    // Unique customers
    const uniqueCustomersRes = await client.query(`
      SELECT COUNT(DISTINCT customer_id) FROM orders
    `);
    const unique_customers = parseInt(uniqueCustomersRes.rows[0].count);

    // Top 5 selling products by quantity (only fulfilled)
    const topProductsRes = await client.query(`
      SELECT p.name, SUM(oi.quantity) AS quantity_sold
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'Fulfilled'
      GROUP BY p.name
      ORDER BY quantity_sold DESC
      LIMIT 5
    `);

    const top_products = topProductsRes.rows;

    client.release();

    res.json({
      total_orders,
      total_revenue,
      total_items_sold,
      unique_customers,
      top_products
    });
  } catch (err) {
    console.error('Error fetching sales summary:', err);
    res.status(500).json({ error: 'Failed to fetch sales summary' });
  }
});

// Get latest order timestamp
app.get('/api/admin/orders/latest-timestamp', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT MAX(created_at) AS latest FROM orders`
    );
    res.json({ latest: result.rows[0].latest });
  } catch (err) {
    console.error("Error fetching latest order timestamp:", err);
    res.status(500).json({ error: "Failed to fetch timestamp" });
  }
});

app.patch("/api/admin/orders/:id/note", async (req, res) => {
  const orderId = req.params.id;
  const { note } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: "Order ID is required" });
  }

  try {
    const result = await pool.query(
      "UPDATE orders SET notes = $1 WHERE id = $2 RETURNING *",
      [note, orderId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ message: "Note updated successfully", order: result.rows[0] });
  } catch (err) {
    console.error("Error updating order note:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.patch('/api/admin/order-items/:id/discount', async (req, res) => {
  const orderItemId = req.params.id;
  const { negotiated_price } = req.body;

  if (negotiated_price == null) {
    return res.status(400).json({ error: "Missing negotiated_price value" });
  }

  try {
    const result = await pool.query(
      `UPDATE order_items SET negotiated_price = $1 WHERE id = $2`,
      [negotiated_price, orderItemId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Order item not found" });
    }

    res.json({ message: "Discount updated successfully" });
  } catch (err) {
    console.error("Error updating discount:", err);
    res.status(500).json({ error: "Failed to update discount" });
  }
});

const PDFDocument = require('pdfkit');
const fs = require('fs');
app.get('/api/admin/orders/:id/invoice', async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    // Step 1: Check if invoice already exists
    const existingInvoice = await pool.query(
      `SELECT invoice_number, invoice_date 
       FROM invoices 
       WHERE order_id = $1`, 
       [orderId]
    );

    let invoiceNumber, invoiceDate;
    if (existingInvoice.rows.length > 0) {
      invoiceNumber = existingInvoice.rows[0].invoice_number;
      invoiceDate = existingInvoice.rows[0].invoice_date;
    } else {
      // Step 2: Generate new invoice number
      const seqRes = await pool.query(`SELECT nextval('invoice_seq') AS seq`);
      const seqNum = String(seqRes.rows[0].seq).padStart(6, '0');

      const orderDateRes = await pool.query(
        `SELECT created_at FROM orders WHERE id = $1`,
        [orderId]
      );
      if (orderDateRes.rows.length === 0) {
        return res.status(404).json({ error: "Order not found" });
      }

      const orderDate = orderDateRes.rows[0].created_at;
      const datePart = new Date(orderDate).toISOString().slice(0, 10).replace(/-/g, "");
      invoiceNumber = `INV-${orderId}-${datePart}-${seqNum}`;
      invoiceDate = new Date();

      // Step 3: Insert invoice
      await pool.query(
        `INSERT INTO invoices (order_id, invoice_number, invoice_date) 
         VALUES ($1, $2, $3)`,
        [orderId, invoiceNumber, invoiceDate]
      );
    }

    // Fetch order + items + product details (include HSN, CGST, SGST)
    const orderQuery = `
      SELECT o.id AS order_id, o.customer_id, c.name AS customer_name, o.created_at,
             oi.id AS order_item_id, p.name AS product_name, p.hsn, p.cgst, p.sgst, p.cess,
             oi.quantity, oi.negotiated_price
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE o.id = $1
    `;
    const { rows } = await pool.query(orderQuery, [orderId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = {
      order_id: rows[0].order_id,
      customer_name: rows[0].customer_name,
      customer_id: rows[0].customer_id,
      created_at: rows[0].created_at,
      items: rows.map(item => {
        const finalPrice = parseFloat(item.negotiated_price) * item.quantity;
        const taxableAmt = finalPrice / (1 + (parseFloat(item.cgst) + parseFloat(item.sgst) + parseFloat(item.cess)) / 100);
        return {
          product_name: item.product_name,
          hsn: item.hsn,
          quantity: item.quantity,
          cgst: parseFloat(item.cgst),
          sgst: parseFloat(item.sgst),
          cess: parseFloat(item.cess),
          taxable_amt: taxableAmt,
          final_price: finalPrice
        };
      })
    };

    // PDF
    const doc = new PDFDocument({
  margins: { top: 50, left: 20, right: 20, bottom: 50 }
});
    res.setHeader('Content-Disposition', `attachment; filename=invoice_order_${orderId}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    // Header
    doc.fontSize(20).text("Baba Merchant Store", { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text("Tiloi, District - Amethi");
    doc.text("GSTIN: 09ARTPA0714F1Z0");
    doc.text("Phone: +91-9839645091, +91-7081156224");
    doc.text("Email: bms@gmail.com");
    doc.moveDown();

    // Invoice Heading
    doc.fontSize(18).text("Delivery Challan", { align: 'center' });
    doc.moveDown();

    // Customer Info
    doc.fontSize(12).text(`Order ID: ${order.order_id}`);
    doc.text(`Customer Name: ${order.customer_name}`);
    doc.text(`Customer ID: ${order.customer_id}`);
    doc.text(`Order Date: ${new Date(order.created_at).toLocaleDateString()}`, { continued: true })
       .text(`Invoice Date: ${new Date(invoiceDate).toLocaleDateString()}`, { align: 'right' });
    doc.text(`Invoice No: ${invoiceNumber}`);
    doc.moveDown();

    // Table Header
    const colWidths = [150, 60, 40, 80, 50, 50, 50, 80]; 
    // Product | HSN | Qty | Taxable Amt | CGST | SGST | Cess |Final Price
const startX = 20;
let x = startX;
const tableTop = doc.y + 5;
doc.fontSize(11).font('Helvetica-Bold');
[
  'Product', 'HSN', 'Qty', 'Taxable Amt', 'CGST %', 'SGST %', 'Cess %', 'Final Price'
].forEach((header, i) => {
  doc.text(header, x, tableTop, { width: colWidths[i], underline: true, align: (i > 1 ? 'right' : 'left') });
  x += colWidths[i];
});

  let y = tableTop + 20;
let grandTotal = 0;
doc.font('Helvetica').fontSize(10);

order.items.forEach((item, index) => {
  grandTotal += item.final_price;
  const rowHeight = 20;

  // Alternate row shading
  if (index % 2 === 0) {
    doc.rect(startX, y - 2, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill('#f5f5f5').fillColor('black');
  }

  // Reset x for each row
  x = startX;
  const rowValues = [
    item.product_name,
    item.hsn,
    item.quantity.toString(),
    item.taxable_amt.toFixed(2),
    item.cgst.toFixed(2),
    item.sgst.toFixed(2),
    item.cess.toFixed(2),
    item.final_price.toFixed(2)
  ];

  rowValues.forEach((val, i) => {
    doc.text(val, x, y, { width: colWidths[i], align: (i > 1 ? 'right' : 'left') });
    x += colWidths[i];
  });

  // Draw bottom line
  doc.moveTo(startX, y + rowHeight).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y + rowHeight).stroke();

  y += rowHeight + 5;
});

// Grand Total
doc.moveTo(startX, y + 5).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y + 5).stroke();
doc.font('Helvetica-Bold').text('Grand Total:', startX + 400, y + 10, { width: 100, align: 'right' });
doc.text(grandTotal.toFixed(2), startX + 480, y + 10, { width: 80, align: 'right' });


    doc.end();
  } catch (err) {
    console.error("Error generating invoice:", err);
    res.status(500).json({ error: "Failed to generate invoice" });
  }
});


function signSalespersonToken(sp) {
  // keep payload minimal
  return jwt.sign({ sid: sp.id, name: sp.name }, JWT_SECRET, { expiresIn: '7d' });
}

// middleware to protect salesperson routes
function requireSalespersonAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const cookieToken = req.cookies.sp_jwt;

    const token = cookieToken || (header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const payload = jwt.verify(token, JWT_SECRET);
    req.salesperson = payload; // { sid, name, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

app.post('/api/salesperson/login', async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = email OR phone
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier and password are required' });
    }

    const q = `
      SELECT id, name, email, phone, password_hash, status
      FROM salespersons
      WHERE (LOWER(email) = LOWER($1) OR phone = $1)
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [identifier]);
    const sp = rows[0];

    if (!sp || sp.status !== 'active') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, sp.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signSalespersonToken(sp);

    // httpOnly cookie so the dashboard can make authenticated calls without storing token in JS
    res.cookie('sp_jwt', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,          // set true when you serve over HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    return res.json({ id: sp.id, name: sp.name, email: sp.email, phone: sp.phone });
  } catch (err) {
    console.error('Salesperson login failed:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// Who am I? (useful to verify cookie works)
app.get('/api/salesperson/me', requireSalespersonAuth, async (req, res) => {
  res.json({ id: req.salesperson.sid, name: req.salesperson.name });
});

// Logout
app.post('/api/salesperson/logout', (req, res) => {
  res.clearCookie('sp_jwt');
  res.json({ ok: true });
});

// -------------------- SALESPERSON ROUTES --------------------



// Middleware to authenticate salesperson
function authenticateSalesperson(req, res, next) {
  const headerToken = req.headers['authorization']?.split(' ')[1];
  const cookieToken = req.cookies.sp_jwt; // ✅ read from cookie
  const token = headerToken || cookieToken;

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET); // ✅ use correct secret
    req.user = decoded; // contains sid from login
    next();
  } catch (err) {
    return res.status(400).json({ error: 'Invalid token.' });
  }
}



// 1. Get assigned customers
app.get('/api/salesperson/customers', authenticateSalesperson, async (req, res) => {
  try {
    const salespersonId = req.user.sid; // from JWT
    const result = await pool.query(
      `SELECT customer_id, name, phone, region
       FROM customers
       WHERE salesperson_id = $1
       ORDER BY name ASC`,
      [salespersonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching assigned customers:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 2. Search products
app.get('/api/salesperson/products', authenticateSalesperson, async (req, res) => {
  try {
    const search = req.query.search || '';
    const result = await pool.query(
      `SELECT id, name, base_price, min_retail_price, company_id
       FROM products
       WHERE name ILIKE $1
       ORDER BY name ASC`,
      [`%${search}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 3. Create order
app.post('/api/salesperson/orders', authenticateSalesperson, async (req, res) => {
  const client = await pool.connect();
  try {
    const salespersonId = req.user.sid;
    const { customer_id, items } = req.body; // items = [{product_id, quantity, unit_price, negotiated_price}]

    if (!customer_id || !items || items.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query('BEGIN');

    // Create order
    const orderRes = await client.query(
      `INSERT INTO orders (customer_id, salesperson_id, status, created_at)
       VALUES ($1, $2, 'Pending', NOW())
       RETURNING id AS order_id`,
      [customer_id, salespersonId]
    );

    const orderId = orderRes.rows[0].order_id;

    // Insert order items
    for (let item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, negotiated_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.product_id, item.quantity, item.unit_price, item.negotiated_price || 0]
      );
    }

    await client.query('COMMIT');

    res.json({ success: true, order_id: orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error creating salesperson order:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


// 4. View salesperson's orders
app.get('/api/salesperson/orders', authenticateSalesperson, async (req, res) => {
  try {
    const salespersonId = req.user.sid;
    const result = await pool.query(
      `SELECT o.id AS order_id, o.status, o.created_at, c.name AS customer_name
       FROM orders o
       JOIN customers c ON o.customer_id = c.customer_id
       WHERE o.salesperson_id = $1
       ORDER BY o.created_at DESC`,
      [salespersonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching salesperson orders:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Create new order (Salesperson)
app.post('/api/salesperson/orders', authenticateSalesperson, async (req, res) => {
  const client = await pool.connect();

  try {
    const { customer_id, items } = req.body; // items = [{ product_id, quantity, unit_price, negotiated_price }]
    if (!customer_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Invalid order data" });
    }

    await client.query('BEGIN');

    // Insert order
    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, salesperson_id, created_at)
       VALUES ($1, $2, NOW())
       RETURNING id`,
      [customer_id, req.user.sid]
    );
    const orderId = orderResult.rows[0].id;

    // Insert order items
    for (let item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, negotiated_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.product_id, item.quantity, item.unit_price, item.negotiated_price]
      );
    }

    await client.query('COMMIT');
    res.json({ message: "Order created successfully", order_id: orderId });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error creating order:", err);
    res.status(500).json({ error: "Failed to create order" });
  } finally {
    client.release();
  }
});

app.get('/api/salesperson/companies', authenticateSalesperson, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, logo_url FROM companies ORDER BY name`);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching companies:", err);
    res.status(500).json({ error: "Failed to fetch companies" });
  }
});

app.get('/api/salesperson/companies/:companyId/products', authenticateSalesperson, async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    const { rows } = await pool.query(`
      SELECT id, name, image_url, base_price, price, min_retail_price, is_active
      FROM products
      WHERE company_id = $1
      ORDER BY name
    `, [companyId]);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get('/api/salesperson/orders/:orderId', authenticateSalesperson, async (req, res) => {
  try {
    const salespersonId = req.user.sid;
    const orderId = req.params.orderId;

    // Ensure salesperson owns this order
    const orderResult = await pool.query(
      `SELECT o.id AS order_id, o.status, o.created_at, c.name AS customer_name
       FROM orders o
       JOIN customers c ON o.customer_id = c.customer_id
       WHERE o.id = $1 AND o.salesperson_id = $2`,
      [orderId, salespersonId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

const itemsResult = await pool.query(
  `SELECT p.name, oi.quantity, oi.negotiated_price,
          (oi.quantity * oi.negotiated_price)::float AS line_total
   FROM order_items oi
   JOIN products p ON oi.product_id = p.id
   WHERE oi.order_id = $1`,
  [orderId]
);


    res.json({
      ...orderResult.rows[0],
      items: itemsResult.rows
    });

  } catch (err) {
    console.error("Error fetching order details:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add salesperson

app.post('/api/admin/salespersons', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO salespersons (name, email, password_hash, phone)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, email, hashedPassword, phone]
    );
    res.json({ message: "Salesperson created", salesperson_id: result.rows[0].salesperson_id });
  } catch (err) {
    console.error("Error adding salesperson:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete('/api/admin/salespersons/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE salespersons SET status = 'inactive' WHERE id = $1`, [req.params.id]);
    res.json({ message: "Salesperson removed successfully" });
  } catch (err) {
    console.error("Error removing salesperson:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/salespersons", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, phone, status FROM salespersons WHERE status = 'active'  ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching salespersons:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get all retailers
// ✅ Get all retailers (customers) with salesperson info
app.get('/api/admin/retailers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.customer_id, c.name, c.phone, c.email,c.region, c.salesperson_id,
             CASE WHEN s.status = 'inactive' THEN 'Unassigned' ELSE s.name END AS salesperson_name
      FROM customers c
      LEFT JOIN salespersons s ON c.salesperson_id = s.id
      ORDER BY c.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching retailers:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ✅ Add new retailer (customer)
app.post('/api/admin/retailers', async (req, res) => {
  try {
    const { name, phone, email, password, region, salesperson_id, customer_id } = req.body;

    if (!name || !salesperson_id) {
      return res.status(400).json({ error: "Retailer name and salesperson_id are required" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO customers (name, phone, email, password, region, salesperson_id, customer_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [name, phone, email, hashedPassword, region, salesperson_id, customer_id || null]
    );

    res.json({
      message: "Retailer added successfully",
      id: result.rows[0].customer_id
    });
  } catch (err) {
    console.error("❌ Error adding retailer:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update retailers details
app.put('/api/admin/retailers/:id', async (req, res) => {
  try {
    const { name, phone, email, region, customer_id, salesperson_id } = req.body;
    const result = await pool.query(
      `UPDATE customers
       SET name = $1, phone = $2, email = $3, region=$4, customer_id = $5, salesperson_id = $6
       WHERE id = $7
       RETURNING *`,
      [name, phone, email, region, customer_id, salesperson_id , req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Retailer not found" });
    }
    res.json({ message: "Retailer updated", customers: result.rows[0] });
  } catch (err) {
    console.error("Error updating retailer:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/admin/retailers/:id
app.delete('/api/admin/retailers/:id', async (req, res) => {
  const retailerId = req.params.id;
  try {
    const result = await pool.query(
      'DELETE FROM customers WHERE id = $1',
      [retailerId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Retailer not found' });
    }
    res.json({ message: 'Retailer deleted successfully' });
  } catch (err) {
    console.error('Error deleting retailer:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all companies
app.get("/api/admin/companies", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM companies");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Update company details
app.put('/api/admin/companies/:id', async (req, res) => {
  try {
    const { name, logo_url } = req.body;
    const { id } = req.params;

    const result = await pool.query(
      'UPDATE companies SET name = $1, logo_url = $2 WHERE id = $3 RETURNING *',
      [name, logo_url, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Company not found" });
    }

    res.json({ message: "Company updated successfully", company: result.rows[0] });
  } catch (err) {
    console.error("Error updating company:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete('/api/admin/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json({ message: 'Company deleted successfully' });
  } catch (err) {
    console.error('Error deleting company:', err);
    res.status(500).json({ error: 'Server error' });
  }
});



// Get retailers assigned to a salesperson
app.get('/api/admin/salespersons/:id/retailers', async (req, res) => {
  try {
    const salespersonId = req.params.id;
    const result = await pool.query(
      `SELECT c.customer_id, c.name, c.email, c.phone 
       FROM customers c
       JOIN salespersons sr ON sr.id = c.salesperson_id
       WHERE sr.id = $1`,
      [salespersonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching retailers for salesperson:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update salesperson details
app.put('/api/admin/salespersons/:id', async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    const result = await pool.query(
      `UPDATE salespersons
       SET name = $1, email = $2, phone = $3
       WHERE id = $4 AND status = 'active'
       RETURNING *`,
      [name, email, phone, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Salesperson not found" });
    }
    res.json({ message: "Salesperson updated", salesperson: result.rows[0] });
  } catch (err) {
    console.error("Error updating salesperson:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.post('/api/admin/salespersons/:id/assign-retailers', async (req, res) => {
  const { retailer_ids } = req.body; // Array of retailer IDs
  try {
    // Remove old assignments
    await pool.query(`DELETE FROM salesperson_customers WHERE salesperson_id = $1`, [req.params.id]);

    // Add new assignments
    for (let rid of retailer_ids) {
      await pool.query(
        `INSERT INTO salesperson_customers (salesperson_id, customer_id) VALUES ($1, $2)`,
        [req.params.id, rid]
      );
    }

    res.json({ message: "Retailers assigned successfully" });
  } catch (err) {
    console.error("Error assigning retailers:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add new customer
app.post('/api/admin/customers', async (req, res) => {
  const { name, phone, address, is_retailer } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO customers (name, phone, address, is_retailer)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, phone, address, is_retailer]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error adding customer:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update existing customer
app.put('/api/admin/customers/:id', async (req, res) => {
  const { name, phone, address, is_retailer } = req.body;
  try {
    await pool.query(
      `UPDATE customers SET name = $1, phone = $2, address = $3, is_retailer = $4 WHERE customer_id = $5`,
      [name, phone, address, is_retailer, req.params.id]
    );
    res.json({ message: "Customer updated successfully" });
  } catch (err) {
    console.error("Error updating customer:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/api/admin/companies', async (req, res) => {
  const { name, logo_url } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO companies (name, logo_url) VALUES ($1, $2) RETURNING *`,
      [name, logo_url]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error adding company:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put('/api/admin/orders/:id/items', async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { items } = req.body; // Expected: [{ product_id, quantity, negotiated_price }]
  
  if (isNaN(orderId)) {
    return res.status(400).json({ error: "Invalid order ID" });
  }
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Items must be an array" });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete existing order items for this order
    await client.query(
      'DELETE FROM order_items WHERE order_id = $1',
      [orderId]
    );

    // 2. Insert all items anew (could be optimized, but simple and clean)
    for (const item of items) {
      const { product_id, quantity, negotiated_price } = item;

      if (!product_id || !quantity || quantity < 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "Invalid product data in items" });
      }

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, negotiated_price, unit_price)
         SELECT $1, $2, $3, $4, base_price
         FROM products WHERE id = $2`,
        [orderId, product_id, quantity, negotiated_price || 0]
      );
    }

    await client.query('COMMIT');
    res.json({ message: "Order updated successfully" });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to update order:', err);
    res.status(500).json({ error: "Server error updating order" });
  } finally {
    client.release();
  }
});

app.get('/api/admin/sales-summary/by-salesperson', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        sp.name AS salesperson_name,
        COUNT(DISTINCT o.id) AS total_orders,
        COUNT(DISTINCT o.customer_id) AS total_customers,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_sales,
        CASE 
          WHEN COUNT(DISTINCT o.id) = 0 THEN 0 
          ELSE COALESCE(SUM(oi.quantity * oi.unit_price), 0)::float / COUNT(DISTINCT o.id) 
        END AS avg_sales_per_order
      FROM salespersons sp
      LEFT JOIN orders o ON o.salesperson_id = sp.id AND o.status = 'Fulfilled'
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY sp.name
      ORDER BY sp.name;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching sales KPIs by salesperson:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ Create new order from Admin Dashboard (with items)
app.post('/api/admin/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const { salesperson_id, customer_id, notes, items } = req.body;

    if (!salesperson_id || !customer_id || !items || items.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    const orderRes = await client.query(
      `INSERT INTO orders (salesperson_id, customer_id, notes, status, created_at)
       VALUES ($1, $2, $3, 'pending', NOW())
       RETURNING id`,
      [salesperson_id, customer_id, notes || null]
    );

    const order_id = orderRes.rows[0].id;



    for (const item of items) {

      const productRes = await client.query(
    `SELECT price FROM products WHERE id = $1`,
    [item.product_id]
  );
  const unit_price = productRes.rows[0].price;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, negotiated_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [order_id, item.product_id, item.quantity, unit_price, item.negotiated_price]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Order created successfully", id: order_id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating order:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

app.post('/api/admin/retailers/bulk-reassign', async (req, res) => {
  const { fromSalespersonId, toSalespersonId } = req.body;
  if (!fromSalespersonId || !toSalespersonId || fromSalespersonId === toSalespersonId) {
    return res.status(400).json({ error: 'Invalid salesperson selection.' });
  }
  try {
    await pool.query(
      'UPDATE customers SET salesperson_id = $1 WHERE salesperson_id = $2',
      [toSalespersonId, fromSalespersonId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to bulk reassign retailers:', err);
    res.status(500).json({ error: 'Server error during reassignment.' });
  }
});

app.post('/api/salesperson/customers/add', authenticateSalesperson, async (req, res) => {
  const salespersonId = req.user.sid; // ID from login/session/auth token
  const { name, phone, email, password, region, customer_id } = req.body;
  const hashedpassword = await bcrypt.hash(password, 10);
  if (!name || !phone || !email || !hashedpassword || !region || !customer_id) {
    return res.status(400).json({ error: "All fields are required." });
  }
  try {
    await pool.query(
      'INSERT INTO customers (name, phone, email, password, region, customer_id, salesperson_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [name, phone, email, hashedpassword, region, customer_id, salespersonId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to add retailer:', err);
    res.status(500).json({ error: 'Server error while adding retailer.' });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));





