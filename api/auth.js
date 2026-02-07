const { Pool } = require('pg');
const { attachDatabasePool } = require('@vercel/functions');

// Global pool
let pool = null;
let isInitialized = false;

async function getPool() {
  if (isInitialized && pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set in Vercel env vars (Neon integration).');
  }

  console.log('🔌 Initializing Neon Postgres pool...');
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 15000,
    keepAlive: true,
  });

  attachDatabasePool(pool);

  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('✅ Neon connected');
  } finally {
    client.release();
  }

  isInitialized = true;
  return pool;
}

async function initializeTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      api_key VARCHAR(255) UNIQUE NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS keys (
      id SERIAL PRIMARY KEY,
      key VARCHAR(255) UNIQUE NOT NULL,
      api VARCHAR(255) NOT NULL,
      prefix VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      hwid TEXT,
      banned BOOLEAN DEFAULT FALSE,
      used BOOLEAN DEFAULT FALSE,
      device_limit INTEGER DEFAULT 1,
      system_info TEXT,
      first_used TIMESTAMP,
      FOREIGN KEY (api) REFERENCES applications(api_key) ON DELETE CASCADE
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS supports (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) UNIQUE NOT NULL,
      added_by VARCHAR(255) NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
    INSERT INTO supports (user_id, added_by) 
    VALUES ('techdavisk007', 'system')
    ON CONFLICT (user_id) DO NOTHING
  `);

  console.log('✅ Tables initialized');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
    }),
  };
}

const MAIN_ADMIN_ID = 'techdavisk007';
const MAX_APPS_FOR_SUPPORT = 10;

async function checkIfAdmin(user_id) {
  return user_id === MAIN_ADMIN_ID;
}

async function getUserAppCount(pool, user_id) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM applications WHERE created_by = $1',
    [user_id]
  );
  return parseInt(result.rows[0].count);
}

async function checkAppPermission(pool, user_id, api_key) {
  if (await checkIfAdmin(user_id)) return { hasPermission: true, isAdmin: true };

  const supportCheck = await pool.query('SELECT * FROM supports WHERE user_id = $1', [user_id]);
  if (supportCheck.rows.length > 0) return { hasPermission: true, isAdmin: false };

  const result = await pool.query(
    'SELECT * FROM applications WHERE api_key = $1 AND created_by = $2',
    [api_key, user_id]
  );
  return { hasPermission: result.rows.length > 0, isAdmin: false };
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const poolInstance = await getPool();

    if (!isInitialized) {
      const client = await poolInstance.connect();
      try {
        await initializeTables(client);
      } finally {
        client.release();
      }
    }

    let body = {};
    if (event.body && event.httpMethod === 'POST') {
      try {
        body = JSON.parse(event.body);
      } catch {
        return jsonResponse(400, { success: false, message: 'Invalid JSON' });
      }
    }

    const { action } = body;

    if (event.httpMethod === 'GET' && event.path.includes('/health')) {
      return jsonResponse(200, { success: true, message: 'API Health OK - Neon connected', version: '2.1-vercel' });
    }

    switch (action) {
      case 'check_support':
        const { user_id: cs_uid } = body;
        if (!cs_uid) return jsonResponse(400, { success: false, message: 'User ID required' });
        const cs_res = await poolInstance.query('SELECT * FROM supports WHERE user_id = $1', [cs_uid]);
        return jsonResponse(200, cs_res.rows.length > 0 
          ? { success: true, is_support: true, user: cs_res.rows[0] }
          : { success: false, is_support: false, message: 'No permission' });

      case 'test':
        return jsonResponse(200, { success: true, message: 'API working with Neon!' });

      case 'create_app':
        const { app_name, user_id: ca_uid } = body;
        if (!app_name || !ca_uid) return jsonResponse(400, { success: false, message: 'App name & User ID required' });
        const ca_isAdmin = await checkIfAdmin(ca_uid);
        const ca_count = await getUserAppCount(poolInstance, ca_uid);
        if (!ca_isAdmin && ca_count >= MAX_APPS_FOR_SUPPORT) {
          return jsonResponse(200, { success: false, message: `Limit ${MAX_APPS_FOR_SUPPORT} apps reached` });
        }
        const ca_api = 'api_' + Math.random().toString(36).substr(2, 16);
        try {
          await poolInstance.query(
            'INSERT INTO applications (name, api_key, created_by) VALUES ($1, $2, $3)',
            [app_name, ca_api, ca_uid]
          );
          return jsonResponse(200, { success: true, message: 'App created', api_key: ca_api });
        } catch (e) {
          if (e.code === '23505') return jsonResponse(200, { success: false, message: 'App exists' });
          throw e;
        }

      case 'delete_app':
        const { app_name: da_name, user_id: da_uid } = body;
        if (!da_name || !da_uid) return jsonResponse(400, { success: false, message: 'Required fields missing' });
        const da_app = await poolInstance.query('SELECT * FROM applications WHERE name = $1', [da_name]);
        if (da_app.rows.length === 0) return jsonResponse(200, { success: false, message: 'App not found' });
        const da_perm = await checkAppPermission(poolInstance, da_uid, da_app.rows[0].api_key);
        if (!da_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        await poolInstance.query('DELETE FROM applications WHERE name = $1', [da_name]);
        return jsonResponse(200, { success: true, message: 'App deleted' });

      case 'create_key':
        const { api: ck_api, prefix, days, device_limit, user_id: ck_uid } = body;
        if (!ck_api || !prefix || !days || !ck_uid) return jsonResponse(400, { success: false, message: 'Missing fields' });
        const ck_perm = await checkAppPermission(poolInstance, ck_uid, ck_api);
        if (!ck_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        const ck_key = `\( {prefix}- \){generateKey()}`;
        const ck_expires = new Date(Date.now() + days * 86400000);
        const ck_limit = parseInt(device_limit) || 1;
        await poolInstance.query(
          'INSERT INTO keys (key, api, prefix, expires_at, device_limit) VALUES ($1, $2, $3, $4, $5)',
          [ck_key, ck_api, prefix, ck_expires, ck_limit]
        );
        return jsonResponse(200, { success: true, message: 'Key created', key: ck_key });

      case 'delete_key':
        const { api: dk_api, key: dk_key, user_id: dk_uid } = body;
        if (!dk_api || !dk_key || !dk_uid) return jsonResponse(400, { success: false, message: 'Missing fields' });
        const dk_perm = await checkAppPermission(poolInstance, dk_uid, dk_api);
        if (!dk_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        const dk_res = await poolInstance.query('DELETE FROM keys WHERE key = $1 AND api = $2 RETURNING *', [dk_key, dk_api]);
        return jsonResponse(dk_res.rows.length > 0 ? 200 : 200, dk_res.rows.length > 0 
          ? { success: true, message: 'Key deleted' } 
          : { success: false, message: 'Key not found' });

      case 'ban_key':
        const { api: bk_api, key: bk_key, user_id: bk_uid } = body;
        if (!bk_api || !bk_key || !bk_uid) return jsonResponse(400, { success: false, message: 'Missing fields' });
        const bk_perm = await checkAppPermission(poolInstance, bk_uid, bk_api);
        if (!bk_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        const bk_res = await poolInstance.query('UPDATE keys SET banned = true WHERE key = $1 AND api = $2 RETURNING *', [bk_key, bk_api]);
        return jsonResponse(bk_res.rows.length > 0 ? 200 : 200, bk_res.rows.length > 0 
          ? { success: true, message: 'Key banned' } 
          : { success: false, message: 'Key not found' });

      case 'check_key':
        const { api: chk_api, key: chk_key, user_id: chk_uid } = body;
        if (!chk_api || !chk_key || !chk_uid) return jsonResponse(400, { success: false, message: 'Missing fields' });
        const chk_perm = await checkAppPermission(poolInstance, chk_uid, chk_api);
        if (!chk_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        const chk_res = await poolInstance.query('SELECT * FROM keys WHERE key = $1 AND api = $2', [chk_key, chk_api]);
        return jsonResponse(chk_res.rows.length > 0 ? 200 : 200, chk_res.rows.length > 0 
          ? { success: true, key: chk_res.rows[0] } 
          : { success: false, message: 'Key not found' });

      case 'reset_hwid':
        const { api: rh_api, key: rh_key, user_id: rh_uid } = body;
        if (!rh_api || !rh_key || !rh_uid) return jsonResponse(400, { success: false, message: 'Missing fields' });
        const rh_perm = await checkAppPermission(poolInstance, rh_uid, rh_api);
        if (!rh_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        const rh_res = await poolInstance.query(
          'UPDATE keys SET hwid = NULL, used = false, system_info = NULL, first_used = NULL WHERE key = $1 AND api = $2 RETURNING *',
          [rh_key, rh_api]
        );
        return jsonResponse(rh_res.rows.length > 0 ? 200 : 200, rh_res.rows.length > 0 
          ? { success: true, message: 'HWID reset' } 
          : { success: false, message: 'Key not found' });

      case 'get_apps':
        const { user_id: ga_uid } = body;
        if (!ga_uid) return jsonResponse(400, { success: false, message: 'User ID required' });
        const ga_isAdmin = await checkIfAdmin(ga_uid);
        const ga_support = await poolInstance.query('SELECT * FROM supports WHERE user_id = $1', [ga_uid]);
        const ga_isSupport = ga_support.rows.length > 0;
        let ga_query = `
          SELECT a.*, COALESCE(COUNT(k.id), 0) as key_count 
          FROM applications a LEFT JOIN keys k ON a.api_key = k.api 
          GROUP BY a.id ORDER BY a.created_at DESC
        `;
        let ga_params = [];
        if (!ga_isAdmin && !ga_isSupport) {
          ga_query = ga_query.replace('FROM applications a', 'FROM applications a WHERE a.created_by = $1');
          ga_params = [ga_uid];
        }
        const ga_res = await poolInstance.query(ga_query, ga_params);
        return jsonResponse(200, { success: true, applications: ga_res.rows, is_admin: ga_isAdmin });

      case 'get_my_apps':
        const { user_id: gma_uid } = body;
        if (!gma_uid) return jsonResponse(400, { success: false, message: 'User ID required' });
        const gma_res = await poolInstance.query(
          'SELECT * FROM applications WHERE created_by = $1 ORDER BY created_at DESC',
          [gma_uid]
        );
        return jsonResponse(200, { success: true, applications: gma_res.rows });

      case 'get_keys':
      case 'list_keys':
        const { api: gk_api, user_id: gk_uid } = body;
        if (!gk_api || !gk_uid) return jsonResponse(400, { success: false, message: 'API & User ID required' });
        const gk_perm = await checkAppPermission(poolInstance, gk_uid, gk_api);
        if (!gk_perm.hasPermission) return jsonResponse(403, { success: false, message: 'No permission' });
        const gk_res = await poolInstance.query(
          'SELECT * FROM keys WHERE api = $1 ORDER BY created_at DESC',
          [gk_api]
        );
        return jsonResponse(200, { success: true, keys: gk_res.rows });

      case 'add_support':
        const { user_id: as_uid, admin_id: as_admin } = body;
        if (!as_uid || !as_admin) return jsonResponse(400, { success: false, message: 'User ID & Admin ID required' });
        if (!await checkIfAdmin(as_admin)) return jsonResponse(403, { success: false, message: 'Only admin can add' });
        try {
          await poolInstance.query(
            'INSERT INTO supports (user_id, added_by) VALUES ($1, $2)',
            [as_uid, as_admin]
          );
          return jsonResponse(200, { success: true, message: `Support ${as_uid} added` });
        } catch (e) {
          if (e.code === '23505') return jsonResponse(200, { success: false, message: 'Already support' });
          throw e;
        }

      case 'delete_support':
        const { user_id: ds_uid, admin_id: ds_admin } = body;
        if (!ds_uid || !ds_admin) return jsonResponse(400, { success: false, message: 'User ID & Admin ID required' });
        if (!await checkIfAdmin(ds_admin)) return jsonResponse(403, { success: false, message: 'Only admin can delete' });
        if (ds_uid === MAIN_ADMIN_ID) return jsonResponse(400, { success: false, message: 'Cannot delete main admin' });
        const ds_res = await poolInstance.query('DELETE FROM supports WHERE user_id = $1 RETURNING *', [ds_uid]);
        return jsonResponse(ds_res.rows.length > 0 ? 200 : 200, ds_res.rows.length > 0 
          ? { success: true, message: 'Support deleted' } 
          : { success: false, message: 'Not found' });

      case 'get_supports':
        const gs_res = await poolInstance.query('SELECT * FROM supports ORDER BY added_at DESC');
        return jsonResponse(200, { success: true, supports: gs_res.rows });

      case 'validate_key':
        const { api: vk_api, key: vk_key, hwid, system_info } = body;
        if (!vk_api || !vk_key || !hwid) return jsonResponse(400, { success: false, message: 'API, Key, HWID required' });
        const vk_app = await poolInstance.query('SELECT * FROM applications WHERE api_key = $1', [vk_api]);
        if (vk_app.rows.length === 0) return jsonResponse(200, { success: false, message: 'Invalid API' });
        const vk_kres = await poolInstance.query('SELECT * FROM keys WHERE key = $1 AND api = $2', [vk_key, vk_api]);
        if (vk_kres.rows.length === 0) return jsonResponse(200, { success: false, message: 'Invalid key' });
        const vk_k = vk_kres.rows[0];
        if (vk_k.banned) return jsonResponse(200, { success: false, message: 'Key banned' });
        if (new Date() > new Date(vk_k.expires_at)) return jsonResponse(200, { success: false, message: 'Key expired' });
        let hwids = vk_k.hwid ? JSON.parse(vk_k.hwid) : [];
        if (hwids.includes(hwid)) return jsonResponse(200, { success: true, message: 'Valid key' });
        const limit = vk_k.device_limit || 1;
        if (hwids.length >= limit) return jsonResponse(200, { success: false, message: 'Device limit reached' });
        hwids.push(hwid);
        await poolInstance.query(
          `UPDATE keys SET hwid = $1, used = true, system_info = $2, first_used = COALESCE(first_used, CURRENT_TIMESTAMP) 
           WHERE key = $3 AND api = $4`,
          [JSON.stringify(hwids), system_info || null, vk_key, vk_api]
        );
        return jsonResponse(200, { success: true, message: 'Valid key' });

      case 'check_permission':
        const { user_id: cp_uid, api: cp_api } = body;
        if (!cp_uid) return jsonResponse(400, { success: false, message: 'User ID required' });
        const cp_perm = await checkAppPermission(poolInstance, cp_uid, cp_api || '');
        const cp_count = await getUserAppCount(poolInstance, cp_uid);
        const cp_isAdmin = await checkIfAdmin(cp_uid);
        return jsonResponse(200, {
          success: true,
          has_permission: cp_perm.hasPermission,
          is_admin: cp_isAdmin,
          app_count: cp_count,
          max_apps: cp_isAdmin ? 999 : MAX_APPS_FOR_SUPPORT
        });

      default:
        if (event.httpMethod === 'GET') {
          return jsonResponse(200, { success: true, message: 'KeyAuth API running on Vercel + Neon', version: '2.1', copyright: 'techdavisk007' });
        }
        return jsonResponse(400, { success: false, message: `Invalid action: ${action || 'none'}` });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    return jsonResponse(500, { success: false, message: 'Server error: ' + error.message });
  }
};