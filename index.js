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

    const r = await pool.query(`
      SELECT userid, username, fullname, role, customertype
      FROM tblusers
      WHERE username=$1 AND passwordhash=$2
    `, [username, password]);

    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");
    res.json({ success: true, token, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// PRODUCTS
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

// ----------------------------------------------------------
// SERIES (RESTORED)
// ----------------------------------------------------------
app.get("/series", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT seriesname AS "SeriesName"
      FROM tblseries
      WHERE isactive = true
      ORDER BY seriesname
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/customers", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT
        customerid   AS "CustomerID",
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
// CATEGORIES (RESTORED)
// ----------------------------------------------------------
app.get("/categories", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT categoryname AS "CategoryName"
      FROM tblcategory
      WHERE isactive = true
      ORDER BY categoryname
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// IMAGES (MANAGE IMAGE PAGE)
// ----------------------------------------------------------
app.get("/images/list", async (_, res) => {
  const r = await pool.query(`
    SELECT
      P.productid AS "ProductID",
      P.item AS "Item",
      COALESCE(I.imageurl,'') AS "ImageURL"
    FROM tblproduct P
    LEFT JOIN tblitemimages I ON I.productid = P.productid
    ORDER BY P.item
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// IMAGE SAVE (OLD – ITEM BASED)  ✅ RESTORED
// ----------------------------------------------------------
app.post("/image/save", async (req, res) => {
  try {
    const { Item, ImageURL } = req.body;

    if (!Item || !ImageURL) {
      return res.status(400).json({ error: "Item and ImageURL required" });
    }

    const p = await pool.query(
      `SELECT productid FROM tblproduct WHERE item = $1`,
      [Item]
    );

    if (p.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    await pool.query(
      `
      INSERT INTO tblitemimages (productid, imageurl)
      VALUES ($1,$2)
      ON CONFLICT (productid)
      DO UPDATE SET imageurl = EXCLUDED.imageurl
      `,
      [p.rows[0].productid, ImageURL]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// IMAGE SAVE (NEW – PRODUCTID BASED, MANAGE IMAGES)
// ----------------------------------------------------------
app.post("/images/save", async (req, res) => {
  try {
    const { ProductID, ImageURL } = req.body;

    if (!ProductID || !ImageURL) {
      return res.status(400).json({ error: "ProductID and ImageURL required" });
    }

    await pool.query(`
      INSERT INTO tblItemImages (ProductID, ImageURL)
      VALUES ($1,$2)
      ON CONFLICT (ProductID)
      DO UPDATE SET ImageURL = EXCLUDED.ImageURL
    `, [ProductID, ImageURL]);

    res.json({ success: true });
  } catch (err) {
    console.error("IMAGE SAVE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------
// STOCK  ❌ UNCHANGED
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
      FROM vwstocksummary
      ORDER BY item
    `);

    if (role === "Customer" && customerType == 1) return res.json([]);

    if (role === "Customer" && customerType == 2) {
      return res.json(r.rows.map(s => ({
        ProductID: s.ProductID,
        Item: s.Item,
        SeriesName: s.SeriesName,
        CategoryName: s.CategoryName,
        Availability: Number(s.TotalQty) > 5 ? "Available" : ""
      })));
    }

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// INCOMING (PURCHASE)  ❌ UNCHANGED
// ----------------------------------------------------------
app.post("/incoming", async (req, res) => {
  const client = await pool.connect();
  try {
    const { UserName, Location, Rows } = req.body;
    await client.query("BEGIN");

    const h = await client.query(`
      INSERT INTO tblincomingheader (username, location)
      VALUES ($1,$2) RETURNING incomingheaderid
    `, [UserName, Location]);

    const headerId = h.rows[0].incomingheaderid;

    for (const r of Rows) {
      const p = await client.query(`
        SELECT productid FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
      `, [r.Item, r.SeriesName, r.CategoryName]);

      const productId = p.rows.length
        ? p.rows[0].productid
        : (await client.query(`
            INSERT INTO tblproduct (item, seriesname, categoryname)
            VALUES ($1,$2,$3) RETURNING productid
          `, [r.Item, r.SeriesName, r.CategoryName])).rows[0].productid;

      await client.query(`
        INSERT INTO tblincomingdetails
        (incomingheaderid, productid, item, seriesname, categoryname, quantity)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [headerId, productId, r.Item, r.SeriesName, r.CategoryName, r.Quantity]);

      await client.query(`
        INSERT INTO tblstock (productid, totalquantity)
        VALUES ($1,$2)
        ON CONFLICT (productid)
        DO UPDATE SET totalquantity = tblstock.totalquantity + EXCLUDED.totalquantity
      `, [productId, r.Quantity]);
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------
// SALES  ❌ UNCHANGED
// ----------------------------------------------------------
app.post("/sales", async (req, res) => {
  const client = await pool.connect();
  try {
    const { UserName, Location, Customer, VoucherNo, Rows } = req.body;
    await client.query("BEGIN");

    const h = await client.query(`
      INSERT INTO tblsalesheader
      (username, locationname, customer, voucherno)
      VALUES ($1,$2,$3,$4) RETURNING salesid
    `, [UserName, Location, Customer, VoucherNo]);

    const salesId = h.rows[0].salesid;

    for (const r of Rows) {
      const p = await client.query(`
        SELECT productid FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
      `, [r.Item, r.SeriesName, r.CategoryName]);

      const productId = p.rows[0].productid;

      await client.query(`
        INSERT INTO tblsalesdetails
        (salesid, productid, item, quantity, series, category)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [salesId, productId, r.Item, r.Quantity, r.SeriesName, r.CategoryName]);

      await client.query(`
        UPDATE tblstock
        SET totalquantity = totalquantity - $1
        WHERE productid=$2
      `, [r.Quantity, productId]);
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------
// START
// ----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Karni API running on ${PORT}`)
);
