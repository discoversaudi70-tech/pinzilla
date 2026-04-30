// PinForge Upload API - CommonJS

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const { provider, imageBase64, fileName, mimeType,
      cloudName, uploadPreset, imgbbKey,
      bunnyStorageZone, bunnyAccessKey, bunnyStorageRegion, bunnyCdnHostname, bunnyFolder
    } = body;

    if (!provider) return res.status(400).json({ error: 'Missing provider' });

    // ── BUNNY ──────────────────────────────────────────────────
    if (provider === 'bunny') {
      if (!bunnyStorageZone || !bunnyAccessKey || !bunnyCdnHostname)
        return res.status(400).json({ error: 'Missing Bunny credentials' });

      const regionMap = {
        '':'storage.bunnycdn.com', 'de':'storage.bunnycdn.com',
        'ny':'ny.storage.bunnycdn.com', 'la':'la.storage.bunnycdn.com',
        'sg':'sg.storage.bunnycdn.com', 'uk':'uk.storage.bunnycdn.com',
        'se':'se.storage.bunnycdn.com', 'br':'br.storage.bunnycdn.com',
        'syd':'syd.storage.bunnycdn.com', 'jh':'jh.storage.bunnycdn.com',
      };
      const region  = (bunnyStorageRegion || '').toLowerCase().trim();
      const host    = regionMap[region] || 'storage.bunnycdn.com';
      const folder  = (bunnyFolder || '').replace(/^\/|\/$/g, '');
      const safe    = Date.now() + '-' + (fileName || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '-');
      const path    = folder ? '/' + bunnyStorageZone + '/' + folder + '/' + safe
                             : '/' + bunnyStorageZone + '/' + safe;
      const buffer  = Buffer.from(imageBase64, 'base64');

      const r = await fetch('https://' + host + path, {
        method: 'PUT',
        headers: { 'AccessKey': bunnyAccessKey, 'Content-Type': mimeType || 'image/jpeg' },
        body: buffer,
      });

      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(400).json({ error: 'Bunny HTTP ' + r.status + ': ' + t.substring(0, 200) });
      }

      const cdn = bunnyCdnHostname.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const url = folder ? 'https://' + cdn + '/' + folder + '/' + safe
                         : 'https://' + cdn + '/' + safe;
      return res.status(200).json({ url });
    }

    // ── CLOUDINARY ─────────────────────────────────────────────
    if (provider === 'cloudinary') {
      if (!cloudName || !uploadPreset)
        return res.status(400).json({ error: 'Missing cloudName or uploadPreset' });
      const boundary = 'PF' + Date.now();
      const CRLF = '\r\n';
      const body2 = [
        '--' + boundary, 'Content-Disposition: form-data; name="file"', '',
        'data:' + (mimeType || 'image/jpeg') + ';base64,' + imageBase64,
        '--' + boundary, 'Content-Disposition: form-data; name="upload_preset"', '',
        uploadPreset, '--' + boundary + '--',
      ].join(CRLF);
      const r = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/image/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: body2,
      });
      const d = await r.json();
      if (d.secure_url) return res.status(200).json({ url: d.secure_url });
      return res.status(400).json({ error: (d.error && d.error.message) || 'Cloudinary failed' });
    }

    // ── IMGBB ──────────────────────────────────────────────────
    if (provider === 'imgbb') {
      if (!imgbbKey) return res.status(400).json({ error: 'Missing imgbbKey' });
      const p = new URLSearchParams(); p.append('image', imageBase64);
      const r = await fetch('https://api.imgbb.com/1/upload?key=' + imgbbKey, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString(),
      });
      const d = await r.json();
      if (d.success) return res.status(200).json({ url: d.data.url });
      return res.status(400).json({ error: (d.error && d.error.message) || 'ImgBB failed' });
    }

    return res.status(400).json({ error: 'Unknown provider: ' + provider });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upload error' });
  }
};
