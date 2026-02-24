const { logActivity } = require('./activityLogger');
require("./firebase");
const {
  notifyAdminLogin,
  notifyAdminSale,
  notifyIncoming,
  notifyAppUpdate,
  notifyNewImage
} = require("./notificationService");
 
// ----------------------------------------------------------
// KARNI FASHIONS BACKEND — PostgreSQL (Supabase)
// ----------------------------------------------------------
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { pool } = require("./db");
const { getFlipkartAccessToken } = require("./services/flipkartAuth");
const app = express();
const SellingPartnerAPI = require("amazon-sp-api");

// ----------------------------------------------------------
// MIDDLEWARE
// ----------------------------------------------------------
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
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
function buildStockCondition(mode, role) {
  // Customers are always forced to "either"
  if (role === "customer") {
    return `(s.jaipurqty > 5 OR s.kolkataqty > 5 OR s.ahmedabadqty > 5)`;
  }

  switch (mode) {
    case "all":
      return null; // IMPORTANT: means "do not use stock at all"
    case "jaipur":
      return `s.jaipurqty > 5`;
    case "kolkata":
      return `s.kolkataqty > 5`;
case "ahmedabad":
  return `s.ahmedabadqty > 5`;

    case "either":
    default:
      return `(s.jaipurqty > 5 OR s.kolkataqty > 5 OR s.ahmedabadqty > 5)`;
  }
}
async function isOnlineEnabled(productid) {
  const { data, error } = await supabase
    .from("tbl_online_design")
    .select("is_online")
    .eq("productid", productid)
    .single();

  if (error) return false;
  return data?.is_online === true;
}

// ----------------------------------------------------------
// ROOT
// ----------------------------------------------------------
app.get("/", (_, res) => {
  res.send("Karni Fashions API (PostgreSQL) is live");
});
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});
app.get("/spapi/marketplaces", async (req, res) => {
  try {
    const sp = new SellingPartnerAPI({
      region: "na",
      refresh_token: process.env.SP_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.LWA_CLIENT_SECRET,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_ROLE_ARN: process.env.AWS_ROLE_ARN
      }
    });

    const data = await sp.callAPI({
      operation: "getMarketplaceParticipations",
      endpoint: "sellers"
    });

    res.json(data);

  } catch (e) {
    console.error("SPAPI ERROR:", e);
    res.status(500).json({
      error: "SP-API call failed",
      details: e.message
    });
  }
});

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

const r = await pool.query(
  `
  SELECT userid, username, fullname, role
  FROM tblusers
  WHERE LOWER(username) = LOWER($1)
    AND passwordhash = $2
  `,
  [username, password]
);


    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = r.rows[0];

    await logActivity({
      userId: user.userid,
      username: user.username,
      actionType: "LOGIN",
      description: `User ${user.username} logged in`
    });

    // 🔔 LOGIN NOTIFICATION (ADMIN ONLY)
    try {
      await notifyAdminLogin(user.fullname);
    } catch (err) {
      console.error("Login notification failed:", err);
      // DO NOT block login
    }

    const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");

    return res.json({
      success: true,
      token,
      user
    });

  } catch (e) {
    console.error("LOGIN ERROR:", e);
    return res.status(500).json({
      error: e?.message || "Unknown server error"
    });
  }
});


app.post("/signup", async (req, res) => {
  try {
    const {
      username,
      password,
      fullName,
      businessName,
      address,
      mobile
    } = req.body;

    // Basic validation
    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required"
      });
    }

    // Check if username already exists
    const exists = await pool.query(
      "SELECT 1 FROM tblusers WHERE username = $1",
      [username]
    );

    if (exists.rows.length > 0) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    // Insert user (ONLY existing columns)
    const insert = await pool.query(
      `
      INSERT INTO tblusers
      (
        username,
        passwordhash,
        fullname,
        businessname,
        address,
        mobile
      )
      VALUES
        ($1,$2,$3,$4,$5,$6)
      RETURNING
        userid,
        username,
        fullname,
        role
      `,
      [
        username,
        password,          // later replace with bcrypt hash
        fullName || null,
        businessName || null,
        address || null,
        mobile || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Signup successful",
      user: insert.rows[0]
    });

  } catch (e) {
    console.error("SIGNUP ERROR:", e);
    return res.status(500).json({
      error: e.message
    });
  }
});


// ----------------------------------------------------------
// PRODUCTS
// ----------------------------------------------------------
app.get("/products", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT
        productid AS "ProductID",
        item AS "Item",
        seriesname AS "SeriesName",
        categoryname AS "CategoryName",
        origin AS "Origin"
      FROM tblproduct
      ORDER BY item
    `);

    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});


// ----------------------------------------------------------
// SERIES (RESTORED)
// ----------------------------------------------------------
app.get("/series", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT
        seriesname   AS "SeriesName",
        categoryname AS "CategoryName",
        rate         AS "Rate"
      FROM tblseries
      WHERE isactive = true
      ORDER BY seriesname
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/series/rate", async (req, res) => {
  try {
    const { SeriesName, Rate } = req.body;

    if (!SeriesName) {
      return res.status(400).json({ error: "SeriesName required" });
    }

    await pool.query(
      `
      UPDATE tblseries
      SET rate = $1
      WHERE seriesname = $2
      `,
      [Rate ?? null, SeriesName]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("SERIES RATE UPDATE ERROR:", e.message);
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
app.post("/categories", async (req, res) => {
  try {
    const { CategoryName } = req.body;
    if (!CategoryName) {
      return res.status(400).json({ error: "CategoryName required" });
    }

    await pool.query(
      `INSERT INTO tblcategory (categoryname, isactive)
       VALUES ($1, true)`,
      [CategoryName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("CATEGORY POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/series", async (req, res) => {
  try {
    const { SeriesName, CategoryName } = req.body;
    if (!SeriesName || !CategoryName) {
      return res.status(400).json({ error: "SeriesName & CategoryName required" });
    }

    await pool.query(
      `INSERT INTO tblseries (seriesname, categoryname, isactive)
       VALUES ($1, $2, true)`,
      [SeriesName.trim(), CategoryName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("SERIES POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/products", async (req, res) => {
  try {
    const { Item, SeriesName, CategoryName, Origin } = req.body;

    if (!Item || !SeriesName || !CategoryName || !Origin) {
      return res.status(400).json({ error: "All fields required" });
    }

    await pool.query(`
      INSERT INTO tblproduct (item, seriesname, categoryname, origin)
      VALUES ($1, $2, $3, $4)
    `, [Item, SeriesName, CategoryName, Origin]);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save product" });
  }
});


app.post("/customers", async (req, res) => {
  try {
    const { CustomerName } = req.body;
    if (!CustomerName) {
      return res.status(400).json({ error: "CustomerName required" });
    }

    await pool.query(
      `INSERT INTO tblcustomer (customername)
       VALUES ($1)`,
      [CustomerName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("CUSTOMER POST ERROR:", e.message);
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
  try {
    const r = await pool.query(`
      SELECT
        P.productid              AS "ProductID",
        P.item                   AS "Item",
        COALESCE(I.fabric, '')   AS "Fabric",
        COALESCE(S.rate, 0)      AS "Rate",
        COALESCE(I.imageurl, '') AS "ImageURL"
      FROM tblproduct P
      LEFT JOIN tblitemimages I
        ON I.productid = P.productid
      LEFT JOIN tblseries S
        ON S.seriesname = P.seriesname
      ORDER BY P.item
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("❌ /images/list error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// IMAGE SAVE (OLD – ITEM BASED)  ✅ RESTORED
// ----------------------------------------------------------
app.post("/image/save", async (req, res) => {
  try {
    const { Item, ImageURL, Fabric } = req.body;

    if (!Item) {
      return res.status(400).json({ error: "Item required" });
    }

    console.log("🔥 IMAGE/SAVE CALLED", { Item, ImageURL, Fabric});

    // 1️⃣ Find product
    const p = await pool.query(
      `SELECT productid, seriesname FROM tblproduct WHERE item = $1`,
      [Item]
    );

    if (p.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const productId = p.rows[0].productid;
    const seriesName = p.rows[0].seriesname;

    // 2️⃣ Insert / Update image + fabric + rate
    await pool.query(
      `
   INSERT INTO tblitemimages (productid, imageurl, fabric)
VALUES ($1,$2,$3)
ON CONFLICT (productid)
DO UPDATE SET
  imageurl = EXCLUDED.imageurl,
  fabric   = EXCLUDED.fabric

      `,
      [productId, ImageURL || '', Fabric || '']

    );

    // 3️⃣ Notify
    await notifyNewImage({
      imageUrl: ImageURL,
      seriesName: seriesName,
      itemName: Item
    });

    res.json({ success: true });

  } catch (e) {
    console.error("❌ IMAGE/SAVE ERROR:", e);
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

    console.log("🔥 IMAGE SAVE CALLED", { ProductID, ImageURL });

    // 1️⃣ Save / update image
    await pool.query(
      `
      INSERT INTO tblItemImages (ProductID, ImageURL)
      VALUES ($1,$2)
      ON CONFLICT (ProductID)
      DO UPDATE SET ImageURL = EXCLUDED.ImageURL
      `,
      [ProductID, ImageURL]
    );

    console.log("✅ IMAGE SAVED IN DB");

    // 2️⃣ Fetch item + series
    const info = await pool.query(
      `
      SELECT item, seriesname
      FROM tblproduct
      WHERE productid = $1
      `,
      [ProductID]
    );

    console.log("🔎 PRODUCT LOOKUP RESULT", info.rows);

    // 3️⃣ Send notification
    if (info.rows.length > 0) {
      console.log("📣 SENDING IMAGE NOTIFICATION");

      await notifyNewImage({
        imageUrl: ImageURL,
        seriesName: info.rows[0].seriesname,
        itemName: info.rows[0].item
      });

      console.log("✅ notifyNewImage CALLED");
    } else {
      console.warn("⚠️ NO PRODUCT FOUND FOR NOTIFICATION");
    }

    res.json({ success: true });

  } catch (err) {
    console.error("❌ IMAGE SAVE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/images/series/list-with-item", async (req, res) => {
  try {
    const seriesList = req.body;

    console.log("🔥 SERIES LIST RECEIVED:", seriesList);

    if (!Array.isArray(seriesList) || seriesList.length === 0) {
      return res.status(400).json({ error: "Series list required" });
    }

    const result = await pool.query(`
SELECT
  p.productid             AS "ProductID",
  p.item                  AS "Item",
  COALESCE(i.imageurl,'') AS "ImageURL",
  COALESCE(i.fabric,'')   AS "Fabric",
  COALESCE(s.rate,0)      AS "Rate"
FROM tblproduct p
LEFT JOIN tblitemimages i
  ON i.productid = p.productid
LEFT JOIN tblseries s
  ON s.seriesname = p.seriesname
WHERE p.seriesname = ANY($1)
ORDER BY p.item

    `, [seriesList]);

    console.log("✅ ROW COUNT:", result.rows.length);

    res.json(result.rows);

  } catch (e) {
    console.error("❌ images/series/list-with-item error", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/images/series/:series", async (req, res) => {
  try {
    const { series } = req.params;
    const mode = req.query.mode || "either";
    const role = (req.user?.role || "customer").toLowerCase();

    const stockCondition = buildStockCondition(mode, role);
    const useStock = stockCondition !== null;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        COALESCE(i.imageurl,'n/a') AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      ${useStock ? "JOIN vwstocksummary s ON s.productid = p.productid" : ""}
      WHERE p.seriesname = $1
      ${useStock ? `AND ${stockCondition}` : ""}
      ORDER BY p.item DESC
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
    const mode = req.query.mode || "either";
    const role = (req.user?.role || "customer").toLowerCase();

    const stockCondition = buildStockCondition(mode, role);
    const useStock = stockCondition !== null;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        COALESCE(i.imageurl,'n/a') AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      ${useStock ? "JOIN vwstocksummary s ON s.productid = p.productid" : ""}
      WHERE p.categoryname = $1
      ${useStock ? `AND ${stockCondition}` : ""}
      ORDER BY p.item DESC
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

    if (!Array.isArray(seriesList) || seriesList.length === 0) {
      return res.json([]);
    }

    const query = `
      SELECT
        p.productid              AS "ProductID",
        p.item                   AS "Item",
        COALESCE(i.fabric, '')   AS "Fabric",
        COALESCE(s.rate, 0)      AS "Rate",
        COALESCE(i.imageurl, '') AS "ImageURL"
      FROM tblproduct p
      LEFT JOIN tblitemimages i
        ON i.productid = p.productid
      LEFT JOIN tblseries s
        ON s.seriesname = p.seriesname
      JOIN vwstocksummary v
        ON v.productid = p.productid
      WHERE p.seriesname = ANY($1)
        AND (
  v.jaipurqty > 3
  OR v.kolkataqty > 3
  OR v.ahmedabadqty > 3
)

      ORDER BY p.item DESC
    `;

    const result = await pool.query(query, [seriesList]);
    res.json(result.rows);

  } catch (e) {
    console.error("MULTI-SERIES IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/images/category/list", async (req, res) => {
  try {
    const categoryList = req.body;

    if (!Array.isArray(categoryList) || categoryList.length === 0) {
      return res.json([]);
    }

    const query = `
      SELECT
        p.productid              AS "ProductID",
        p.item                   AS "Item",
        COALESCE(i.fabric, '')   AS "Fabric",
        COALESCE(s.rate, 0)      AS "Rate",
        COALESCE(i.imageurl, '') AS "ImageURL"
      FROM tblproduct p
      LEFT JOIN tblitemimages i
        ON i.productid = p.productid
      LEFT JOIN tblseries s
        ON s.seriesname = p.seriesname
      JOIN vwstocksummary v
        ON v.productid = p.productid
      WHERE p.categoryname = ANY($1)
AND (
  v.jaipurqty > 3
  OR v.kolkataqty > 3
  OR v.ahmedabadqty > 3
)

      ORDER BY p.item DESC
    `;

    const result = await pool.query(query, [categoryList]);
    res.json(result.rows);

  } catch (e) {
    console.error("MULTI-CATEGORY IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// STOCK  ❌ UNCHANGED
// ----------------------------------------------------------
// ----------------------------------------------------------
// STOCK  ✅ ROLE ONLY (FINAL)
// ----------------------------------------------------------


app.post("/stock", async (req, res) => {
  try {
    const { role } = req.body;
    const roleKey = (role || "CUSTOMER").toUpperCase();

    const r = await pool.query(`
      SELECT
        productid AS "ProductID",
        item AS "Item",
        seriesname AS "SeriesName",
        categoryname AS "CategoryName",
        origin AS "Origin",              -- ✅ ADDED
        jaipurqty AS "JaipurQty",
        kolkataqty AS "KolkataQty",
        ahmedabadqty AS "AhmedabadQty",
        totalqty AS "TotalQty"
      FROM vwstocksummary
      ORDER BY item;
    `);

    // ❌ CUSTOMER → NO STOCK
    if (roleKey === "CUSTOMER") {
      return res.json([]);
    }

    // ✅ CUSTOMER_PREMIUM → Availability Only
    if (roleKey === "CUSTOMER_PREMIUM") {
      return res.json(
        r.rows.map(s => ({
          ProductID: s.ProductID,
          Item: s.Item,
          SeriesName: s.SeriesName,
          CategoryName: s.CategoryName,
          Origin: s.Origin,               // ✅ INCLUDED
          JaipurQty: Number(s.JaipurQty),
          KolkataQty: Number(s.KolkataQty)
        }))
      );
    }

    // ✅ ADMIN / USER → FULL STOCK
    return res.json(r.rows);

  } catch (e) {
    console.error("STOCK API ERROR:", e.message);
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

    if (!UserID || !UserName || !Location || !Array.isArray(Rows)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Resolve fullname
    const u = await client.query(
      "SELECT fullname FROM tblusers WHERE userid = $1",
      [UserID]
    );

    if (u.rows.length === 0) {
      throw new Error("Invalid user");
    }

    const createdByName = u.rows[0].fullname;

    // 2️⃣ Insert Incoming Header
    const h = await client.query(
      `
      INSERT INTO tblincomingheader (username, location)
      VALUES ($1, $2)
      RETURNING incomingheaderid
      `,
      [UserName, Location]
    );

    const headerId = h.rows[0].incomingheaderid;

    // 3️⃣ Process Rows
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

      // Stock ledger (TOTAL)
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname,
         quantity, locationname, username)
        VALUES ('Incoming', $1,$2,$3,$4,$5,$6,$7)
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

      // Stock summary
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

      // =====================================================
      // ONLINE SIZE STOCK (SAME PATTERN AS STOCK TRANSFER)
      // =====================================================
      if (
        Location === "Jaipur" &&
        r.SizeQty &&
        typeof r.SizeQty === "object"
      ) {
        for (const [sizeCode, qty] of Object.entries(r.SizeQty)) {
          await client.query(
            `
            UPDATE tbl_online_size_stock
            SET qty = qty + $1
            WHERE productid = $2 AND size_code = $3
            `,
            [Number(qty), productId, sizeCode]
          );
        }
      }
    }

    await client.query("COMMIT");

    // Activity log
    await logActivity({
      userId: UserID,
      username: UserName,
      actionType: "INCOMING",
      description: "Incoming entry created"
    });

    // Notification
    try {
      await notifyIncoming({
        createdByName,
        location: Location,
        incomingHeaderId: headerId
      });
    } catch (err) {
      console.error("Incoming notification failed:", err);
    }

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Incoming error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});


// ----------------------------------------------------------
// SALES  ❌ UNCHANGED
app.post("/sales", async (req, res) => {
  const client = await pool.connect();

  try {
    const { UserName, Location, Customer, VoucherNo, Rows } = req.body;

    if (
      !UserName ||
      !Location ||
      !Customer ||
      !Array.isArray(Rows) ||
      Rows.length === 0
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Resolve user
    const u = await client.query(
      `SELECT userid, fullname FROM tblusers WHERE username = $1`,
      [UserName]
    );

    if (u.rows.length === 0) {
      throw new Error("Invalid user");
    }

    const userId = u.rows[0].userid;
    const createdByName = u.rows[0].fullname;

    // 2️⃣ Sales Header
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

    // 3️⃣ Rows
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

      // 3️⃣a Sales details
      await client.query(
        `
        INSERT INTO tblsalesdetails
        (salesid, productid, item, quantity, series, category)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [salesId, productId, r.Item, r.Quantity, r.SeriesName, r.CategoryName]
      );

      // 3️⃣b Stock ledger (TOTAL stock — unchanged)
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname,
         quantity, locationname, username)
        VALUES ('OUT',$1,$2,$3,$4,$5,$6,$7)
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

      // 3️⃣c Summary stock (derived)
      await client.query(
        `
        UPDATE tblstock
        SET totalquantity = totalquantity - $1
        WHERE productid = $2
        `,
        [r.Quantity, productId]
      );

      // =====================================================
      // ONLINE SIZE STOCK (EXACTLY LIKE STOCK TRANSFER)
      // =====================================================
      if (
        Location === "Jaipur" &&
        r.SizeQty &&
        typeof r.SizeQty === "object"
      ) {
        for (const [sizeCode, qty] of Object.entries(r.SizeQty)) {
          await client.query(
            `
            UPDATE tbl_online_size_stock
            SET qty = qty - $1
            WHERE productid = $2 AND size_code = $3
            `,
            [Number(qty), productId, sizeCode]
          );
        }
      }
    }

    await client.query("COMMIT");

    await logActivity({
      userId,
      username: UserName,
      actionType: "SALES",
      description: "Sales entry created"
    });

    try {
      await notifyAdminSale({
        createdByName,
        customerName: Customer,
        location: Location,
        salesId
      });
    } catch (err) {
      console.error("Sales notification failed:", err);
    }

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Sales error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});


// ----------------------------------------------------------
// STOCK TRANSFER  (ALIGNED WITH INCOMING / SALES)
// ----------------------------------------------------------
app.post("/stock/transfer", async (req, res) => {
  const client = await pool.connect();

  try {
    const { UserName, FromLocation, ToLocation, Rows } = req.body;

    if (!UserName || !FromLocation || !ToLocation || !Array.isArray(Rows))
      return res.status(400).json({ error: "Invalid payload" });

    await client.query("BEGIN");

    // HEADER
    const h = await client.query(
      `
      INSERT INTO tblstocktransferheader
      (fromlocation, tolocation, username)
      VALUES ($1,$2,$3)
      RETURNING transferid
      `,
      [FromLocation, ToLocation, UserName]
    );

    const transferId = h.rows[0].transferid;
    const refId = `T${transferId}`;
    // ROWS
    for (const r of Rows) {
      const p = await client.query(
        `
        SELECT productid
        FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
        `,
        [r.Item, r.SeriesName, r.CategoryName]
      );

      if (!p.rows.length)
        throw new Error(`Product not found: ${r.Item}`);

      const productId = p.rows[0].productid;

      // OUT
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname,
         quantity, locationname, username)
        VALUES ('OUT',$1,$2,$3,$4,$5,$6,$7)
        `,
        [
          refId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity,
          FromLocation,
          UserName
        ]
      );

      // IN
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname,
         quantity, locationname, username)
        VALUES ('Incoming',$1,$2,$3,$4,$5,$6,$7)
        `,
        [
          refId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity,
          ToLocation,
          UserName
        ]
      );
    }

    await client.query("COMMIT");

    await logActivity({
      username: UserName,
      actionType: "STOCK_TRANSFER",
      description: `${FromLocation} → ${ToLocation}`
    });

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("STOCK TRANSFER ERROR:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post("/admin/notify-app-update", async (req, res) => {
  try {
    await notifyAppUpdate();
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
app.get("/online/config", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT *
      FROM vw_online_config
      ORDER BY item
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("ONLINE CONFIG ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// STEP 1: INCOMING LIST (READ-ONLY, VOUCHER LEVEL)
// ----------------------------------------------------------
app.get("/incoming/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        h.incomingheaderid AS "ID",
        h.enteredat        AS "Date",
        h.location         AS "Location",
        COALESCE(SUM(d.quantity), 0) AS "TotalQty"
      FROM tblincomingheader h
      JOIN tblincomingdetails d
        ON d.incomingheaderid = h.incomingheaderid
      GROUP BY h.incomingheaderid, h.enteredat, h.location
      ORDER BY h.incomingheaderid DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("INCOMING LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// STEP 2: SALES LIST (READ-ONLY, VOUCHER LEVEL)
// ----------------------------------------------------------
app.get("/sales/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        h.salesid      AS "ID",
        h."date"       AS "Date",
        h.customer     AS "Customer",
        COALESCE(SUM(d.quantity), 0) AS "TotalQty"
      FROM tblsalesheader h
      JOIN tblsalesdetails d
        ON d.salesid = h.salesid
      GROUP BY h.salesid, h."date", h.customer
      ORDER BY h.salesid DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("SALES LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 3: STOCK TRANSFER LIST (READ-ONLY, VOUCHER LEVEL)
// ----------------------------------------------------------
app.get("/stock/transfer/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        h.transferid   AS "ID",
        h.createdon    AS "Date",
        h.fromlocation AS "FromLocation",
        h.tolocation   AS "ToLocation",
        COALESCE(SUM(l.quantity), 0) AS "TotalQty"
      FROM tblstocktransferheader h
      LEFT JOIN tblstockledger l
        ON l.referenceid = h.transferid
       AND l.movementtype = 'Incoming'
      GROUP BY
        h.transferid,
        h.createdon,
        h.fromlocation,
        h.tolocation
      ORDER BY h.transferid DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("TRANSFER LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 4: VIEW SINGLE INCOMING VOUCHER (READ-ONLY)
// ----------------------------------------------------------
app.get("/incoming/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const header = await pool.query(`
      SELECT
        incomingheaderid,
        username,
        location,
        enteredat
      FROM tblincomingheader
      WHERE incomingheaderid = $1
    `, [id]);

    if (header.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const rows = await pool.query(`
      SELECT
        item,
        seriesname,
        categoryname,
        quantity
      FROM tblincomingdetails
      WHERE incomingheaderid = $1
      ORDER BY incomingdetailid
    `, [id]);

    res.json({
      header: header.rows[0],
      rows: rows.rows
    });

  } catch (e) {
    console.error("VIEW INCOMING ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// IMAGES – FLAT PRODUCT LIST (ORDER IMAGES SCREEN)
// ----------------------------------------------------------
app.get("/images/products", async (_, res) => {
  try {
    const r = await pool.query(`
SELECT
  p.productid              AS "ProductID",
  p.item                   AS "Item",
  p.seriesname             AS "SeriesName",
  COALESCE(i.imageurl,'')  AS "ImageURL",
  COALESCE(i.fabric,'')    AS "Fabric",
  COALESCE(s.rate,0)       AS "Rate"
FROM tblproduct p
LEFT JOIN tblitemimages i
  ON i.productid = p.productid
LEFT JOIN tblseries s
  ON s.seriesname = p.seriesname
ORDER BY p.item

    `);

    res.json(r.rows);
  } catch (e) {
    console.error("❌ /images/products error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// STEP 5: VIEW SINGLE SALES VOUCHER (READ-ONLY)
// ----------------------------------------------------------
app.get("/sales/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const header = await pool.query(`
      SELECT
        salesid,
        username,
        locationname,
        "date",
        customer,
        voucherno
      FROM tblsalesheader
      WHERE salesid = $1
    `, [id]);

    if (header.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const rows = await pool.query(`
      SELECT
        item,
        series,
        category,
        quantity
      FROM tblsalesdetails
      WHERE salesid = $1
      ORDER BY salesdetailid
    `, [id]);

    res.json({
      header: header.rows[0],
      rows: rows.rows
    });

  } catch (e) {
    console.error("VIEW SALES ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/online/sku", async (req, res) => {
  const client = await pool.connect();

  try {
    const rows = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    for (const r of rows) {
      const {
        marketplace,
        productid,
        size_code,
        sku_code
      } = r;

      if (!marketplace || !productid || !size_code) {
        throw new Error("Missing required fields");
      }

      // If SKU is empty → deactivate mapping
      if (!sku_code) {
        await client.query(
          `
          UPDATE tbl_online_sku
          SET is_active = false,
              updated_at = now()
          WHERE marketplace = $1
            AND productid = $2
            AND size_code = $3
          `,
          [marketplace, productid, size_code]
        );
        continue;
      }

      // Upsert SKU mapping
      await client.query(
        `
        INSERT INTO tbl_online_sku
          (marketplace, productid, size_code, sku_code, is_active)
        VALUES
          ($1, $2, $3, $4, true)
        ON CONFLICT (marketplace, productid, size_code)
        DO UPDATE SET
          sku_code = EXCLUDED.sku_code,
          is_active = true,
          updated_at = now()
        `,
        [marketplace, productid, size_code, sku_code]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Online SKU error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});
app.get("/online/sku/:marketplace", async (req, res) => {
  try {
    const { marketplace } = req.params;

    const r = await pool.query(
      `
      SELECT productid, size_code, sku_code
      FROM tbl_online_sku
      WHERE marketplace = $1
        AND is_active = true
      ORDER BY productid, size_code
      `,
      [marketplace.toUpperCase()]
    );

    res.json(r.rows);
  } catch (e) {
    console.error("Load SKU error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/online/sku/confirm", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      pending_id,
      marketplace,
      productid,
      size_code
    } = req.body;

    if (!pending_id || !marketplace || !productid || !size_code) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Load pending SKU
    const p = await client.query(
      `
      SELECT sku_code
      FROM tbl_online_sku_pending
      WHERE id = $1
        AND marketplace = $2
        AND (status IS NULL OR status = 'PENDING')
      `,
      [pending_id, marketplace]
    );

    if (p.rows.length === 0) {
      throw new Error("Pending SKU not found or already confirmed");
    }

    const skuCode = p.rows[0].sku_code;

    // 2️⃣ Upsert into tbl_online_sku
    await client.query(
      `
      INSERT INTO tbl_online_sku
        (marketplace, productid, size_code, sku_code, is_active)
      VALUES
        ($1, $2, $3, $4, true)
      ON CONFLICT (marketplace, productid, size_code)
      DO UPDATE SET
        sku_code = EXCLUDED.sku_code,
        is_active = true,
        updated_at = now()
      `,
      [marketplace, productid, size_code, skuCode]
    );

    // 3️⃣ Mark pending as CONFIRMED
    await client.query(
      `
      UPDATE tbl_online_sku_pending
      SET
        status = 'CONFIRMED',
        mapped_productid = $1,
        mapped_size_code = $2,
        updated_at = now()
      WHERE id = $3
      `,
      [productid, size_code, pending_id]
    );

    await client.query("COMMIT");
    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Confirm SKU error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});
app.get("/online/sku/pending/amazon", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        sku_code,
        asin,
        name,
        status,
        detected_at
      FROM tbl_online_sku_pending
      WHERE marketplace = 'AMAZON'
      AND status = 'NEW'
      ORDER BY detected_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("Pending Amazon SKU error:", err);
    res.status(500).json({ error: "Failed to load pending SKUs" });
  }
});
app.post("/online/sku/pending/amazon/approve", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      pending_id,
      productid,
      size_code,
      sku_code
    } = req.body;

    if (!pending_id || !productid || !size_code || !sku_code) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Insert into active SKU table
    await client.query(`
      INSERT INTO tbl_online_sku
      (productid, size_code, marketplace, sku_code, is_active)
      VALUES ($1, $2, 'AMAZON', $3, true)
      ON CONFLICT DO NOTHING
    `, [productid, size_code, sku_code]);

    // 2️⃣ Mark pending as mapped
    await client.query(`
      UPDATE tbl_online_sku_pending
      SET
        status = 'MAPPED',
        mapped_productid = $1,
        mapped_size_code = $2,
        updated_at = now()
      WHERE id = $3
    `, [productid, size_code, pending_id]);

    await client.query("COMMIT");
    res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve SKU error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


app.post("/fabric/incoming", async (req, res) => {
  try {
    const {
      entry_date,
      vendor_id,
      fabric_name,
      lot_no,
      quantity,
      rate,
      fold,
      width,
      location_id,
      remarks
    } = req.body;

    await pool.query(`
      INSERT INTO tblfabric_incoming
      (entry_date, vendor_id, fabric_name, lot_no, quantity, rate, fold, width, location_id, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      entry_date,
      vendor_id,
      fabric_name,
      lot_no,
      quantity,
      rate || null,
      fold || null,
      width || null,
      location_id,
      remarks || null
    ]);

    res.json({ success: true });

  } catch (e) {
    console.error("FABRIC INCOMING ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post("/fabric/movement", async (req, res) => {
  try {
    const {
      lot_no,
      design_number,
      from_location_id,
      jobworker_id,
      uom,
      qty_issued,
      issue_date,
      due_date,
      remarks
    } = req.body;

    await pool.query(`
      INSERT INTO tblfabric_movement
      (lot_no, design_number, from_location_id, jobworker_id,
       uom, qty_issued, issue_date, due_date, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      lot_no,
      design_number,
      from_location_id,
      jobworker_id,
      uom,
      qty_issued,
      issue_date,
      due_date || null,
      remarks || null
    ]);

    res.json({ success: true });

  } catch (e) {
    console.error("FABRIC MOVEMENT ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});



// GET Vendors
app.get("/vendors", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT vendor_id, vendor_name
      FROM tblvendor
      WHERE is_active = true
      ORDER BY vendor_name
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ADD Vendor
app.post("/vendors", async (req, res) => {
  try {
    const { vendor_name } = req.body;

    if (!vendor_name)
      return res.status(400).json({ error: "Vendor name required" });

    await pool.query(`
      INSERT INTO tblvendor (vendor_name)
      VALUES ($1)
    `, [vendor_name]);

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get("/locations", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT locationid, locationname
      FROM tbllocation
      WHERE isactive = true
      ORDER BY locationname
    `);

    res.json(r.rows);

  } catch (e) {
    console.error("LOCATIONS ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get("/fabric/lots/available", async (req, res) => {
  try {

    const r = await pool.query(`
      SELECT
  fi.lot_no,
  fi.fabric_name,
  fi.quantity AS total_purchased,
  COALESCE(SUM(fm.qty_issued), 0) AS total_issued,
  fi.location_id,
  l.locationname AS location_name,
  fi.quantity - COALESCE(SUM(fm.qty_issued), 0) AS balance
FROM tblfabric_incoming fi
LEFT JOIN tblfabric_movement fm
  ON fm.lot_no = fi.lot_no
LEFT JOIN tbllocation l
  ON l.locationid = fi.location_id
GROUP BY
  fi.lot_no,
  fi.fabric_name,
  fi.quantity,
  fi.location_id,
  l.locationname
HAVING fi.quantity - COALESCE(SUM(fm.qty_issued), 0) > 0
ORDER BY fi.lot_no

    `);

    res.json(r.rows);

  } catch (e) {
    console.error("AVAILABLE LOTS ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/production/create-job", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      lot_no,
      design_number,
      initial_mtr,
      to_jobworker_id,
      movement_date,
      due_date,
      jobworker_rate,
      remarks
    } = req.body;

    if (
      !lot_no ||
      !design_number ||
      !initial_mtr ||
      !to_jobworker_id ||
      !movement_date
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Create production job
    const jobResult = await client.query(
      `
      INSERT INTO tblproduction_job
      (lot_no, design_number, initial_mtr)
      VALUES ($1,$2,$3)
      RETURNING job_id
      `,
      [lot_no, design_number, initial_mtr]
    );

    const jobId = jobResult.rows[0].job_id;

    // 2️⃣ Create first movement (Factory → First Worker)
    await client.query(
      `
      INSERT INTO tblproduction_movement
      (job_id, from_stage, to_stage,
       from_jobworker_id, to_jobworker_id,
       uom, quantity, jobworker_rate,
       movement_date, due_date, remarks)
      VALUES
      ($1,'FACTORY','PROCESS',
       NULL,$2,
       'MTR',$3,$4,
       $5,$6,$7)
      `,
      [
        jobId,
        to_jobworker_id,
        initial_mtr,
        jobworker_rate || null,
        movement_date,
        due_date || null,
        remarks || null
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      job_id: jobId
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to create production job" });
  } finally {
    client.release();
  }
});
// GET Job Workers
app.get("/jobworkers", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT jw.jobworker_id,
             jw.jobworker_name,
             p.process_name
      FROM tbljobworker jw
      JOIN tblprocess p ON p.process_id = jw.process_id
      ORDER BY jw.jobworker_name
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// PRODUCTION – MOVE TO NEXT STAGE
// ----------------------------------------------------------
app.post("/production/move-next", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      job_id,
      to_jobworker_id,
      quantity,
      uom,
      movement_date,
      due_date,
      jobworker_rate,
      remarks,
      convert_pcs
    } = req.body;

    if (!job_id || quantity == null || !uom || !movement_date) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Get current job
    const jobResult = await client.query(
      `SELECT * FROM tblproduction_job WHERE job_id = $1`,
      [job_id]
    );

    if (!jobResult.rows.length) {
      throw new Error("Job not found");
    }

    const job = jobResult.rows[0];

    // 2️⃣ Get last movement
    const lastMoveResult = await client.query(
      `
      SELECT *
      FROM tblproduction_movement
      WHERE job_id = $1
      ORDER BY movement_id DESC
      LIMIT 1
      `,
      [job_id]
    );

    if (!lastMoveResult.rows.length) {
      throw new Error("No previous movement found");
    }

    const lastMove = lastMoveResult.rows[0];
    const fromStage = lastMove.to_stage;
    const fromWorker = lastMove.to_jobworker_id;

    // 3️⃣ Handle conversion (only from STITCHING)
    if (fromStage === "STITCHING" && !job.converted_pcs) {
      if (!convert_pcs) {
        throw new Error("Conversion required from STITCHING");
      }

      await client.query(
        `UPDATE tblproduction_job SET converted_pcs = $1 WHERE job_id = $2`,
        [convert_pcs, job_id]
      );
    }

    // 4️⃣ Insert new movement
    const isReturningToFactory = Number(to_jobworker_id) === 0;

    await client.query(
      `
      INSERT INTO tblproduction_movement
      (job_id, from_stage, to_stage,
       from_jobworker_id, to_jobworker_id,
       uom, quantity, jobworker_rate,
       movement_date, due_date, remarks)
      VALUES
      ($1,$2,$3,
       $4,$5,
       $6,$7,$8,
       $9,$10,$11)
      `,
      [
        job_id,
        fromStage,
        isReturningToFactory ? "FACTORY" : "PROCESS",
        fromWorker,
        isReturningToFactory ? null : to_jobworker_id,
        uom,
        quantity,
        jobworker_rate || null,
        movement_date,
        due_date || null,
        remarks || null
      ]
    );

    // 5️⃣ Mark completed if returned to factory
    if (isReturningToFactory) {
      await client.query(
        `UPDATE tblproduction_job SET status = 'COMPLETED' WHERE job_id = $1`,
        [job_id]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MOVE NEXT ERROR:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});


// ----------------------------------------------------------
// ADD JOB WORKER
// ----------------------------------------------------------
app.post("/jobworkers", async (req, res) => {
  try {
    const { jobworker_name, process_id } = req.body;

    if (!jobworker_name || !process_id) {
      return res.status(400).json({ error: "Required fields missing" });
    }

    await pool.query(
      `
      INSERT INTO tbljobworker (jobworker_name, process_id)
      VALUES ($1,$2)
      `,
      [jobworker_name, process_id]
    );

    res.json({ success: true });

  } catch (e) {
    console.error("ADD JOBWORKER ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// GET PROCESSES
// ----------------------------------------------------------
app.get("/processes", async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT process_id, process_name
      FROM tblprocess
      ORDER BY process_name
      `
    );

    res.json(r.rows);

  } catch (e) {
    console.error("PROCESS GET ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/production/dashboard", async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT
        j.job_id,
        j.lot_no,
        j.design_number,
        j.initial_mtr,
        j.converted_pcs,
        j.status,

        m.to_stage AS current_stage,
        m.to_jobworker_id,
        jw.jobworker_name,
        p.process_name,

        m.due_date,

        CASE
          WHEN j.status = 'COMPLETED' THEN 'COMPLETED'
          WHEN m.due_date < CURRENT_DATE THEN 'OVERDUE'
          ELSE 'IN_PROCESS'
        END AS live_status

      FROM tblproduction_job j

      JOIN LATERAL (
        SELECT *
        FROM tblproduction_movement
        WHERE job_id = j.job_id
        ORDER BY movement_id DESC
        LIMIT 1
      ) m ON true

      LEFT JOIN tbljobworker jw
        ON jw.jobworker_id = m.to_jobworker_id

      LEFT JOIN tblprocess p
        ON p.process_id = jw.process_id

      ORDER BY j.job_id DESC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load production dashboard" });
  }
});
// ADD Process
app.post("/processes", async (req, res) => {
  try {
    const { process_name } = req.body;

    if (!process_name)
      return res.status(400).json({ error: "Process name required" });

    await pool.query(`
      INSERT INTO tblprocess (process_name)
      VALUES ($1)
    `, [process_name]);

    res.json({ success: true });

  } catch (e) {
    console.error("PROCESS POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get("/fabric/dashboard/live", async (req, res) => {
  try {

    const r = await pool.query(`
      SELECT
        fi.lot_no,
        fi.fabric_name,
        v.vendor_name,
        fi.quantity AS total_purchased,

        COALESCE(SUM(fm.qty_issued) OVER (PARTITION BY fi.lot_no), 0) AS total_issued,
        fi.quantity - COALESCE(SUM(fm.qty_issued) OVER (PARTITION BY fi.lot_no), 0) AS balance,

        fm.design_number,
        jw.jobworker_name,
        p.process_name,
        fm.issue_date,
        fm.due_date,

        CASE
          WHEN fm.due_date IS NOT NULL AND fm.due_date < CURRENT_DATE THEN 'OVERDUE'
          WHEN fm.lot_no IS NOT NULL THEN 'IN PROCESS'
          ELSE 'AVAILABLE'
        END AS status

      FROM tblfabric_incoming fi
      LEFT JOIN tblvendor v ON v.vendor_id = fi.vendor_id
      LEFT JOIN tblfabric_movement fm ON fm.lot_no = fi.lot_no
      LEFT JOIN tbljobworker jw ON jw.jobworker_id = fm.jobworker_id
      LEFT JOIN tblprocess p ON p.process_id = jw.process_id

      ORDER BY fi.lot_no, fm.issue_date DESC
    `);

    res.json(r.rows);

  } catch (e) {
    console.error("DASHBOARD ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/production/history/:job_id", async (req, res) => {
  try {
    const { job_id } = req.params;

    const result = await pool.query(`
      SELECT
        m.movement_id,
        m.from_stage,
        m.to_stage,
        m.uom,
        m.quantity,
        m.jobworker_rate,
        m.movement_date,
        m.due_date,
        m.remarks,

        fw.jobworker_name AS from_worker,
        tw.jobworker_name AS to_worker,
        p.process_name

      FROM tblproduction_movement m

      LEFT JOIN tbljobworker fw
        ON fw.jobworker_id = m.from_jobworker_id

      LEFT JOIN tbljobworker tw
        ON tw.jobworker_id = m.to_jobworker_id

      LEFT JOIN tbljobworker jw
        ON jw.jobworker_id = m.to_jobworker_id

      LEFT JOIN tblprocess p
        ON p.process_id = jw.process_id

      WHERE m.job_id = $1
      ORDER BY m.movement_id ASC
    `, [job_id]);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load job history" });
  }
});
app.get("/fabric/incoming/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        fabric_incoming_id,
        lot_no,
        fabric_name,
        quantity,
        created_at
      FROM tblfabric_incoming
      ORDER BY fabric_incoming_id DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("FABRIC INCOMING LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/fabric/movement/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        fm.fabric_movement_id,
        fm.lot_no,
        fi.fabric_name,
        fm.design_number,
        jw.jobworker_name,
        p.process_name,
        fm.qty_issued,
        fm.issue_date,
        fm.due_date
      FROM tblfabric_movement fm
      JOIN tblfabric_incoming fi ON fi.lot_no = fm.lot_no
      JOIN tbljobworker jw ON jw.jobworker_id = fm.jobworker_id
      JOIN tblprocess p ON p.process_id = jw.process_id
      ORDER BY fm.fabric_movement_id DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("FABRIC MOVEMENT LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// STEP 6: VIEW SINGLE STOCK TRANSFER (READ-ONLY)
// ----------------------------------------------------------
app.get("/stock/transfer/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1️⃣ Header (always numeric ID)
    const header = await pool.query(
      `
      SELECT
        transferid,
        fromlocation,
        tolocation,
        username,
        createdon
      FROM tblstocktransferheader
      WHERE transferid = $1
      `,
      [id]
    );

    if (header.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    // 2️⃣ Ledger rows (support OLD + NEW referenceid format)
    const rows = await pool.query(
      `
      SELECT
        item,
        seriesname,
        categoryname,
        quantity,
        locationname,
        movementtype
      FROM tblstockledger
      WHERE referenceid = $1
         OR referenceid = 'T' || $1
      ORDER BY ledgerid
      `,
      [id]
    );

    res.json({
      header: header.rows[0],
      rows: rows.rows
    });

  } catch (e) {
    console.error("VIEW TRANSFER ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/test/flipkart-token", async (req, res) => {
  try {
    const token = await getFlipkartAccessToken();
    res.json({ ok: true, token: token.slice(0, 20) + "..." });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Token generation failed" });
  }
});


// ----------------------------------------------------------
// APP UPDATE (IN-APP UPDATE CHECK)
// ----------------------------------------------------------
app.get("/app/update", (req, res) => {
  res.json({
    latest_version_code: 12,
    force_update: false,
    download_url: "https://drive.google.com/file/d/1QzHIdeg23D7JluIw1p6hizMH3P7snwkO"
  });
});

// ----------------------------------------------------------
// START
// ----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Karni API running on ${PORT}`)
);
