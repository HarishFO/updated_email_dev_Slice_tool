import express from 'express';
import cors from 'cors';
import sharp from 'sharp';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// Discover accounts from env vars
function discoverAccounts() {
  const accounts = [];
  const env = process.env;
  
  // Check ordered list: KLAVIYO_ACCOUNTS=brick,tc
  const ordered = env.KLAVIYO_ACCOUNTS;
  if (ordered) {
    const ids = ordered.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const id of ids) {
      const keyName = `KLAVIYO_API_KEY_${id.toUpperCase()}`;
      const nameName = `KLAVIYO_ACCOUNT_NAME_${id.toUpperCase()}`;
      if (env[keyName]) {
        accounts.push({ id, name: env[nameName] || id.charAt(0).toUpperCase() + id.slice(1) });
      }
    }
    if (accounts.length > 0) return accounts;
  }
  
  // Auto-discover: KLAVIYO_API_KEY_BRICK, KLAVIYO_API_KEY_TC, etc.
  const pattern = /^KLAVIYO_API_KEY_(.+)$/;
  for (const key of Object.keys(env)) {
    const match = key.match(pattern);
    if (match && match[1] !== 'DEFAULT') {
      const id = match[1].toLowerCase();
      const nameName = `KLAVIYO_ACCOUNT_NAME_${match[1]}`;
      accounts.push({ id, name: env[nameName] || id.charAt(0).toUpperCase() + id.slice(1) });
    }
  }
  
  // Fallback
  if (accounts.length === 0 && (env.KLAVIYO_API_KEY_DEFAULT || env.KLAVIYO_API_KEY || env.KLAVIYO_PRIVATE_KEY)) {
    accounts.push({ id: 'default', name: 'Default' });
  }
  
  return accounts;
}

function getApiKey(accountId) {
  const env = process.env;
  const id = (accountId || 'default').toUpperCase();
  return env[`KLAVIYO_API_KEY_${id}`] || env.KLAVIYO_API_KEY_DEFAULT || env.KLAVIYO_API_KEY || env.KLAVIYO_PRIVATE_KEY || null;
}

// Health check
app.get('/health', (req, res) => {
  const accounts = discoverAccounts();
  res.json({ ok: true, timestamp: new Date().toISOString(), accountCount: accounts.length, accounts: accounts.map(a => a.id) });
});

// List accounts
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = discoverAccounts();
    console.log('Discovered accounts:', accounts);
    res.json({ ok: true, accounts });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Upload slices
app.post('/api/push', async (req, res) => {
  try {
    const { accountId, batchName, imageBase64, logicalWidth, logicalHeight, manualSlices = [] } = req.body;
    
    if (!imageBase64) return res.status(400).json({ ok: false, error: 'Missing imageBase64' });
    if (!Array.isArray(manualSlices) || manualSlices.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing manualSlices' });
    }
    if (!logicalWidth || !logicalHeight) {
      return res.status(400).json({ ok: false, error: 'Missing logicalWidth/logicalHeight' });
    }
    
    const apiKey = getApiKey(accountId);
    if (!apiKey) return res.status(400).json({ ok: false, error: `No API key for account: ${accountId}. Add KLAVIYO_API_KEY_${(accountId || 'DEFAULT').toUpperCase()} to Railway.` });

    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const metadata = await sharp(imageBuffer).metadata();
    const imgW = metadata.width, imgH = metadata.height;
    const scaleX = imgW / logicalWidth, scaleY = imgH / logicalHeight;

    const safeBatchName = String(batchName || 'figma_export').replace(/[^a-zA-Z0-9_-]+/g, '_');
    const results = [];
    
    for (let i = 0; i < manualSlices.length; i++) {
      const { rect } = manualSlices[i];
      if (!rect) continue;
      
      let x = Math.max(0, Math.round(rect.x * scaleX));
      let y = Math.max(0, Math.round(rect.y * scaleY));
      let w = Math.round(rect.width * scaleX);
      let h = Math.round(rect.height * scaleY);
      
      if (x + w > imgW) w = imgW - x;
      if (y + h > imgH) h = imgH - y;
      if (w <= 0 || h <= 0) continue;

      let sliceBuffer = await sharp(imageBuffer).extract({ left: x, top: y, width: w, height: h }).toBuffer();
      const originalKb = sliceBuffer.length / 1024;
      
      const sliceMeta = await sharp(sliceBuffer).metadata();
      const hasAlpha = sliceMeta.channels === 4;
      
      let finalBuffer, mimeType, jpegQuality = null;
      
      if (hasAlpha) {
        finalBuffer = await sharp(sliceBuffer).png({ compressionLevel: 9 }).toBuffer();
        mimeType = 'image/png';
      } else {
        let quality = 85;
        finalBuffer = await sharp(sliceBuffer).jpeg({ quality }).toBuffer();
        while (finalBuffer.length / 1024 > 200 && quality > 50) {
          quality -= 5;
          finalBuffer = await sharp(sliceBuffer).jpeg({ quality }).toBuffer();
        }
        mimeType = 'image/jpeg';
        jpegQuality = quality;
      }
      
      const compressedKb = finalBuffer.length / 1024;
      const uploadResult = await uploadToKlaviyo(apiKey, finalBuffer, mimeType, `${safeBatchName}_slice_${i + 1}`);
      
      results.push({ sliceIndex: i, rect, imageUrl: uploadResult.url, mimeType, jpegQuality, originalKb: Math.round(originalKb * 100) / 100, compressedKb: Math.round(compressedKb * 100) / 100 });
    }

    res.json({ ok: true, accountId, batchName, sliceCount: results.length, slices: results });
  } catch (err) {
    console.error('Push error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function uploadToKlaviyo(apiKey, imageBuffer, mimeType, filename) {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  form.append('file', blob, `${filename}.${ext}`);

  const response = await fetch('https://a.klaviyo.com/api/image-upload', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${apiKey}`,
      'revision': '2026-01-15',
      'Accept': 'application/vnd.api+json'
    },
    body: form
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Klaviyo upload failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const imageUrl = data?.data?.attributes?.image_url || data?.data?.attributes?.url;
  if (!imageUrl) throw new Error('No image URL in Klaviyo response');
  return { url: imageUrl };
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Accounts:', discoverAccounts().map(a => a.id).join(', ') || 'none');
});
