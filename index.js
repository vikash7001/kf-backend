// ----------------------------------------------------------
// KARNI FASHIONS BACKEND — PostgreSQL (Supabase)
// ----------------------------------------------------------
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { pool } = require("./db");

const app = express();

// ----------------------------------------------------------
// FIREBASE
// ----------------------------------------------------------
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// ----------------------------------------------------------
// MIDDLEWARE
// ----------------------------------------------------------
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());
app.use(express.json());

// ----------------------------------------------------------
// ROOT
// ----------------------------------------------------------
app.get("/", (_, res) => {
  res.send("Karni Fashions API (PostgreSQL) is live");
});

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    const q = `
      SELECT
        userid, username, fullname, role, customertype,
        businessname, address, mobile
      FROM tblusers
      WHERE username = $1 AND passwordhash = $2
    `;

    const r = await pool.query(q, [username, password]);

    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = Buffer
      .from(`${username}:${Date.now()}`)
      .toString("base64");

    res.json({ success: true, token, user: r.rows[0] });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed", detail: err.message });
  }
});

// ----------------------------------------------------------
// SIGNUP
// ----------------------------------------------------------
app.post("/signup", async (req, res) => {
  try {
    const { username, password, fullName, businessName, address, mobile } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    await pool.query(
      `
      INSERT INTO tblUsers
      (Username, PasswordHash, FullName, Role, CustomerType, BusinessName, Address, Mobile)
      VALUES ($1,$2,$3,'Customer',1,$4,$5,$6)
      `,
      [username, password, fullName, businessName, address, mobile]
    );

    res.json({ success: true });

  } catch (e) {
    console.error("SIGNUP ERROR:", e);
    res.status(500).json({ error: "Signup failed" });
  }
});

// ----------------------------------------------------------
// FCM TOKEN SAVE
// ----------------------------------------------------------
app.post("/fcm/save", async (req, res) => {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ error: "userId and token required" });
    }

    await pool.query(
      `
      INSERT INTO tblfcm_tokens (user_id, token)
      VALUES ($1, $2)
      ON CONFLICT (token)
      DO UPDATE SET user_id = EXCLUDED.user_id, last_seen = now()
      `,
      [userId, token]
    );

    res.json({ success: true });

  } catch (e) {
    console.error("FCM SAVE ERROR:", e);
    res.status(500).json({ error: "Failed to save FCM token" });
  }
});

// ----------------------------------------------------------
// PRODUCTS & CUSTOMERS
// ----------------------------------------------------------
app.get("/products", async (_, res) => {
  const r = await pool.query(`
    SELECT
      productid AS "ProductID",
      item AS "Item",
      seriesname AS "SeriesName",
      categoryname AS "CategoryName"
    FROM tblproduct
    ORDER BY item
  `);
  res.json(r.rows);
});

app.get("/customers", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT
        customerid AS "CustomerID",
        customername AS "CustomerName"
      FROM tblcustomer
      ORDER BY customername
    `);
    res.json(r.rows);
  } catch (err) {
    console.error("CUSTOMERS API ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------
// SERIES & CATEGORIES
// ----------------------------------------------------------
app.get("/series", async (_, res) => {
  const r = await pool.query(`
    SELECT SeriesName
    FROM tblSeries
    WHERE IsActive = true
    ORDER BY SeriesName
  `);
  res.json(r.rows);
});

app.get("/categories", async (_, res) => {
  const r = await pool.query(`
    SELECT CategoryName
    FROM tblCategory
    WHERE IsActive = true
    ORDER BY CategoryName
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// IMAGES
// ----------------------------------------------------------
app.get("/image/:productId", async (req, res) => {
  const r = await pool.query(
    `
    SELECT ProductID, ImageURL
    FROM tblItemImages
    WHERE ProductID = $1
    `,
    [req.params.productId]
  );
  res.json(r.rows[0] || {});
});

app.get("/images/list", async (_, res) => {
  const r = await pool.query(`
    SELECT
      P.ProductID,
      P.Item,
      COALESCE(I.ImageURL,'') AS ImageURL
    FROM tblProduct P
    LEFT JOIN tblItemImages I ON I.ProductID = P.ProductID
    ORDER BY P.Item
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// IMAGE SAVE  ✅ (ONLY CHANGE MADE HERE)
// ----------------------------------------------------------
app.post("/image/save", async (req, res) => {
  try {
    const { Item, ImageURL } = req.body;

    if (!Item || !ImageURL) {
      return res.status(400).json({ error: "Item and ImageURL required" });
    }

    function convertDrive(url) {
      try {
        const m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
        if (m && m[1]) {
          return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
        }
        return url;
      } catch {
        return url;
      }
    }

    const finalUrl = convertDrive(ImageURL);

    const p = await pool.query(
      `SELECT productid FROM tblproduct WHERE item = $1`,
      [Item]
    );

    if (p.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const productId = p.rows[0].productid;

    await pool.query(
      `
      INSERT INTO tblitemimages (productid, imageurl)
      VALUES ($1, $2)
      ON CONFLICT (productid)
      DO UPDATE SET imageurl = EXCLUDED.imageurl
      `,
      [productId, finalUrl]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("IMAGE SAVE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------
// STOCK
// ----------------------------------------------------------
app.post("/stock", async (req, res) => {
  try {
    const { role, customerType } = req.body;

    const r = await pool.query(`
      SELECT
        productid AS "ProductID",
        item AS "Item",
        seriesname AS "SeriesName",
        categoryname AS "CategoryName",
        jaipurqty AS "JaipurQty",
        kolkataqty AS "KolkataQty",
        totalqty AS "TotalQty"
      FROM vwStockSummary
      ORDER BY item
    `);

    let stock = r.rows;

    if (role === "Customer" && customerType == 1) return res.json([]);

    if (role === "Customer" && customerType == 2) {
      return res.json(stock.map(s => ({
        ProductID: s.ProductID,
        Item: s.Item,
        SeriesName: s.SeriesName,
        CategoryName: s.CategoryName,
        Availability: Number(s.TotalQty) > 5 ? "Available" : ""
      })));
    }

    res.json(stock);

  } catch (err) {
    console.error("STOCK API ERROR:", err);
    res.status(500).json({ error: "Failed to load stock" });
  }
});

// ----------------------------------------------------------
// START
// ----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Karni API running on port ${PORT}`)
);
