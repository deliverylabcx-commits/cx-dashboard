// Vercel 서버 함수: 채널톡 상담의 첨부 사진을 가져와 대시보드에 전달
// - 채널톡 키·시크릿·열람 코드는 Vercel 환경변수(CT_ACCESS_KEY / CT_ACCESS_SECRET / PHOTO_VIEW_CODE)에만 보관
// - 브라우저에는 짧은 시간만 유효한 사진 주소(pre-signed URL)만 전달, 키는 절대 내려보내지 않음
// - 읽기 전용(GET)만 사용
const crypto = require("crypto");

const API = "https://api.channel.io";
const VERSION = "2026-06-01";
const MAX_PAGES = 3, PAGE_LIMIT = 100, MAX_PHOTOS = 12;

function sameCode(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function ct(path) {
  const headers = {
    "x-access-key": process.env.CT_ACCESS_KEY,
    "x-access-secret": process.env.CT_ACCESS_SECRET,
    "Channel-Version": VERSION,
  };
  // 신규 경로(/open/...) 우선, 없으면 v5 경로로 재시도
  let r = await fetch(API + "/open" + path, { headers });
  if (r.status === 404) r = await fetch(API + "/open/v5" + path, { headers });
  if (!r.ok) { const e = new Error("channel " + r.status); e.status = r.status; throw e; }
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET만 지원합니다" });
  if (!process.env.CT_ACCESS_KEY || !process.env.CT_ACCESS_SECRET || !process.env.PHOTO_VIEW_CODE)
    return res.status(500).json({ error: "Vercel 환경변수(CT_ACCESS_KEY / CT_ACCESS_SECRET / PHOTO_VIEW_CODE)가 설정되지 않았습니다" });
  if (!sameCode(req.headers["x-view-code"], process.env.PHOTO_VIEW_CODE))
    return res.status(401).json({ error: "열람 코드가 올바르지 않습니다" });

  try {
    // 연결 점검: /api/photos?ping=1
    if (req.query.ping) {
      const j = await ct("/channel");
      return res.status(200).json({ ok: true, channel: (j.channel || {}).name || "" });
    }

    const chat = String(req.query.chat || "");
    if (!/^[A-Za-z0-9]{8,40}$/.test(chat)) return res.status(400).json({ error: "상담 ID 형식이 올바르지 않습니다" });

    // 상담 메시지에서 이미지 첨부 수집 (최신순, 최대 3페이지)
    const files = [];
    let since = null;
    for (let page = 0; page < MAX_PAGES && files.length < MAX_PHOTOS; page++) {
      const q = `/user-chats/${chat}/messages?sortOrder=desc&limit=${PAGE_LIMIT}` + (since ? `&since=${encodeURIComponent(since)}&cursor=${encodeURIComponent(since)}` : "");
      const j = await ct(q);
      const msgs = j.messages || [];
      msgs.forEach(m => (m.files || []).forEach(f => {
        const isImg = f.type === "image" || /^image\//.test(f.contentType || "");
        if (isImg && f.key && files.length < MAX_PHOTOS)
          files.push({ key: f.key, previewKey: f.previewKey, name: f.name || "", width: f.width, height: f.height, createdAt: m.createdAt });
      }));
      since = j.next || j.cursor || null; // 버전별 페이지 커서 이름 차이 대응
      if (!since || !msgs.length) break;
    }

    // 파일 키 → 짧게 유효한 다운로드 주소
    const urlOf = async key => { try { return (await ct(`/user-chats/${chat}/messages/file?key=${encodeURIComponent(key)}`)).result || null; } catch (e) { return null; } };
    const photos = [];
    for (const f of files) {
      const url = await urlOf(f.key);
      if (!url) continue;
      const thumb = f.previewKey ? (await urlOf(f.previewKey)) || url : url;
      photos.push({ url, thumb, name: f.name, width: f.width, height: f.height, createdAt: f.createdAt });
    }
    return res.status(200).json({ photos });
  } catch (e) {
    const s = e.status === 429 ? 429 : e.status === 401 || e.status === 403 ? 502 : 500;
    const msg = e.status === 429 ? "채널톡 호출이 잠시 몰렸습니다. 잠시 후 다시 시도해 주세요"
              : e.status === 401 || e.status === 403 ? "채널톡 키 권한을 확인해 주세요"
              : e.status === 404 ? "상담을 찾을 수 없습니다" : "사진을 불러오지 못했습니다";
    return res.status(e.status === 404 ? 404 : s).json({ error: msg });
  }
};
