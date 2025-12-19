const { logActivity } = require('./activityLogger');

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
// DISABLE CACHE FOR API RESPONSES (Cloudflare-safe)
// ----------------------------------------------------------
app.use((req, res, next) => {
  // Disable caching for all API responses
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
  next();
});

// ----------------------------------------------------------
// ROOT
// ----------------------------------------------------------
app.get("/", (_, res) => {
  res.send("Karni Fashions API (PostgreSQL) is live");
});
app.get("/health", (req, res) => {
  res.status(200).send("ok");
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
const user = r.rows[0];

await logActivity({
  userId: user.userid,
  username: user.username,
  actionType: 'LOGIN',
  description: `User ${user.username} logged in`
});

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
// REGISTER / UPDATE FCM TOKEN
// ----------------------------------------------------------
app.post("/fcm/register", async (req, res) => {
  try {
    const { user_id, token, device } = req.body;

    if (!user_id || !token) {
      return res.status(400).json({ error: "user_id and token required" });
    }

    await pool.query(`
      INSERT INTO tblfcm_tokens (user_id, token, device, last_seen)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        device = EXCLUDED.device,
        last_seen = NOW()
    `, [user_id, token, device || 'android']);

    res.json({ success: true });
  } catch (e) {
    console.error("FCM REGISTER ERROR:", e.message);
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
app.get("/image/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    const r = await pool.query(`
      SELECT
        i.productid   AS "ProductID",
        i.imageurl    AS "ImageURL"
      FROM tblitemimages i
      JOIN vwstocksummary s ON s.productid = i.productid
      WHERE i.productid = $1
        AND (s.jaipurqty > 5 OR s.kolkataqty > 5)
    `, [productId]);

    if (r.rows.length === 0)
      return res.json({});

    res.json(r.rows[0]);
  } catch (e) {
    console.error("IMAGE FETCH ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/images/series/:series", async (req, res) => {
  try {
    const { series } = req.params;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        i.imageurl  AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      JOIN vwstocksummary s ON s.productid = p.productid
      WHERE p.seriesname = $1
        AND (s.jaipurqty > 5 OR s.kolkataqty > 5)
      ORDER BY p.item
    `, [series]);

    res.json(r.rows);
  } catch (e) {
    console.error("SERIES IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/images/category/:category", async (req, res) => {
  try {
    const { category } = req.params;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        i.imageurl  AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      JOIN vwstocksummary s ON s.productid = p.productid
      WHERE p.categoryname = $1
        AND (s.jaipurqty > 5 OR s.kolkataqty > 5)
      ORDER BY p.item
    `, [category]);

    res.json(r.rows);
  } catch (e) {
    console.error("CATEGORY IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/images/series/list", async (req, res) => {
  try {
    const seriesList = req.body;

    if (!Array.isArray(seriesList) || seriesList.length === 0)
      return res.json([]);

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        i.imageurl  AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      JOIN vwstocksummary s ON s.productid = p.productid
      WHERE p.seriesname = ANY($1)
        AND (s.jaipurqty > 5 OR s.kolkataqty > 5)
      ORDER BY p.item
    `, [seriesList]);

    res.json(r.rows);
  } catch (e) {
    console.error("MULTI-SERIES IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/images/category/list", async (req, res) => {
  try {
    const categoryList = req.body;

    if (!Array.isArray(categoryList) || categoryList.length === 0)
      return res.json([]);

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        i.imageurl  AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      JOIN vwstocksummary s ON s.productid = p.productid
      WHERE p.categoryname = ANY($1)
        AND (s.jaipurqty > 5 OR s.kolkataqty > 5)
      ORDER BY p.item
    `, [categoryList]);

    res.json(r.rows);
  } catch (e) {
    console.error("MULTI-CATEGORY IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
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
    const { UserID, UserName, Location, Rows } = req.body;

    // ✅ Payload validation
    if (!UserID || !UserName || !Location || !Array.isArray(Rows)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Insert Incoming Header
    const h = await client.query(
      `
      INSERT INTO tblincomingheader (username, location)
      VALUES ($1, $2)
      RETURNING incomingheaderid
      `,
      [UserName, Location]
    );

    const headerId = h.rows[0].incomingheaderid;

    // 2️⃣ Process Incoming Rows
    for (const r of Rows) {

      const p = await client.query(
        `
        SELECT productid
        FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
        `,
        [r.Item, r.SeriesName, r.CategoryName]
      );

      const productId = p.rows.length
        ? p.rows[0].productid
        : (
            await client.query(
              `
              INSERT INTO tblproduct (item, seriesname, categoryname)
              VALUES ($1,$2,$3)
              RETURNING productid
              `,
              [r.Item, r.SeriesName, r.CategoryName]
            )
          ).rows[0].productid;

      // Incoming details
      await client.query(
        `
        INSERT INTO tblincomingdetails
        (incomingheaderid, productid, item, seriesname, categoryname, quantity)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [headerId, productId, r.Item, r.SeriesName, r.CategoryName, r.Quantity]
      );

      // Stock ledger
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname, quantity, locationname, username)
        VALUES ('Incoming', $1, $2, $3, $4, $5, $6, $7)
        `,
        [
          headerId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity,
          Location,
          UserName
        ]
      );

      // Stock update
      await client.query(
        `
        INSERT INTO tblstock
        (productid, item, seriesname, categoryname, totalquantity)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (productid)
        DO UPDATE SET totalquantity = tblstock.totalquantity + EXCLUDED.totalquantity
        `,
        [
          productId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity
        ]
      );
    }

    // 3️⃣ Commit transaction
    await client.query("COMMIT");

    // 4️⃣ Activity log (identity = UserID, display = UserName)
    await logActivity({
      userId: UserID,
      username: UserName,
      actionType: "INCOMING",
      description: "Incoming entry created"
    });

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Incoming error:", e);
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

    if (!UserName || !Location || !Customer || !VoucherNo || !Array.isArray(Rows)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Resolve userid from username
    const u = await client.query(
      `SELECT userid FROM tblusers WHERE username = $1`,
      [UserName]
    );

    if (u.rows.length === 0) {
      throw new Error("Invalid user");
    }

    const userId = u.rows[0].userid;

    // 2️⃣ Insert Sales Header
    const h = await client.query(
      `
      INSERT INTO tblsalesheader
      (username, locationname, customer, voucherno)
      VALUES ($1,$2,$3,$4)
      RETURNING salesid
      `,
      [UserName, Location, Customer, VoucherNo]
    );

    const salesId = h.rows[0].salesid;

    // 3️⃣ Process Sales Rows
    for (const r of Rows) {

      const p = await client.query(
        `
        SELECT productid
        FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
        `,
        [r.Item, r.SeriesName, r.CategoryName]
      );

      if (p.rows.length === 0) {
        throw new Error(`Product not found: ${r.Item}`);
      }

      const productId = p.rows[0].productid;

      // Sales details
      await client.query(
        `
        INSERT INTO tblsalesdetails
        (salesid, productid, item, quantity, series, category)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [salesId, productId, r.Item, r.Quantity, r.SeriesName, r.CategoryName]
      );

      // Stock ledger
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname, quantity, locationname, username)
        VALUES ('OUT', $1, $2, $3, $4, $5, $6, $7)
        `,
        [
          salesId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity,
          Location,
          UserName
        ]
      );

      // Stock update
      await client.query(
        `
        UPDATE tblstock
        SET totalquantity = totalquantity - $1
        WHERE productid = $2
        `,
        [r.Quantity, productId]
      );
    }

    // 4️⃣ COMMIT TRANSACTION
    await client.query("COMMIT");

    // 5️⃣ ACTIVITY LOG
    await logActivity({
      userId: userId,
      username: UserName,
      actionType: "SALES",
      description: "Sales entry created"
    });

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Sales error:", e);
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
