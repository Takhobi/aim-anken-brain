/* AIM 案件ブレイン（一般公開版）
 * - 案件リストは jobs.json（運営が定期更新）
 * - プロフィール・選んだ案件・分析・営業文は、すべてこのブラウザの localStorage だけに保存
 * - Claude は「指示文をコピー → 自分の Claude に貼る → 答えを貼り戻す」で使う（APIキー不要）
 */
(() => {
const $ = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => typeof n === "number" ? n.toLocaleString("ja-JP") : esc(n);

/* ---------- 保存（このブラウザだけ） ---------- */
const LS = {
  get(k, d){ try { const v = localStorage.getItem("aimab." + k); return v == null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem("aimab." + k, JSON.stringify(v)); } catch(e){} },
};

const S = {
  step: LS.get("step", "pick"), filter: "all", media: "all",
  base: [], meta: null, loadErr: "",
  custom: LS.get("custom", []), status: LS.get("status", {}), analyses: LS.get("analyses", {}),
  drafts: LS.get("drafts", {}), memo: LS.get("memo", {}), profile: LS.get("profile", null),
  current: null, tab: "B", tone: "A", instr: "", redo: {}, flow: null, reply: "", error: "", running: null,
};
const save = k => LS.set(k, S[k]);

/* ---------- 媒体 ---------- */
const MEDIA = {
  indeed: {name:"Indeed", apply:"応募ページを開く", sent:"自分で応募した", contactOk:true},
  crowdworks: {name:"クラウドワークス", apply:"クラウドワークスで応募", sent:"自分で応募した", contactOk:false},
  lancers: {name:"ランサーズ", apply:"ランサーズで提案", sent:"自分で提案した", contactOk:false},
};
const mkey = j => ({"Indeed":"indeed","クラウドワークス":"crowdworks","ランサーズ":"lancers"})[j.media] || "indeed";
const M = j => MEDIA[mkey(j)];

/* ---------- 案件 ---------- */
const excluded = j => (S.profile?.exclude || []).some(w => w && (j.company||"").includes(w));
const allJobs = () => [...S.base, ...S.custom].filter(j => !excluded(j))
  .map(j => ({...j, status: S.status[j.id]?.s || "new", sentAt: S.status[j.id]?.at || ""}));
const job = id => allJobs().find(j => j.id === id);
const picked = () => allJobs().filter(j => j.status === "pick" || j.status === "sent");
const own = a => (a && a.video) ? a : null;

async function loadJobs(force){
  try{
    const r = await fetch("jobs.json" + (force ? "?t=" + Date.now() : ""), {cache: force ? "no-store" : "default"});
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    S.base = (d.jobs || []).sort((a,b) => (a.order ?? 99) - (b.order ?? 99));
    S.meta = d; S.loadErr = "";
    if (force) toast("最新の案件リストを読み込みました（" + (d.updatedAt || "") + "更新）");
  }catch(e){ S.loadErr = "案件リストを読み込めませんでした。時間をおいて再読み込みしてください。"; }
  render();
}
function setStatus(id, s){
  const cur = S.status[id]?.s || "new";
  const next = cur === s ? "new" : s;
  if (next === "new") delete S.status[id];
  else S.status[id] = {s: next, at: next === "sent" ? new Date().toISOString().slice(0,10) : (S.status[id]?.at || "")};
  save("status"); render();
}

/* ---------- 送信前チェック ---------- */
const BANNED = ["拝見いたしました","拝見しました","と感じました","非常に","と思います","ご検討いただけますと幸いです","改善できる点として","さらに成果につながると感じました","見込めます"];
const JARGON = ["視聴維持率","スワイプ離脱","ファーストビュー","CTA","完全視聴率","おすすめフィード","要約テロップ","離脱"];
const LEFTOVER = ["1〜2行","実績があれば","無ければ空欄のままでOK","★","ここに提案が入る"];
function lint(text){
  const t = text || "";
  const blanks = (t.match(/【\s*】|【　+】|【[^】]*(ご自身|お名前|連絡先|ポートフォリオ|URL|◯)[^】]*】/g) || []).length;
  const contact = ["連絡先","メールアドレス","LINE","電話番号","Chatwork ID","@gmail","@yahoo"].filter(w => t.includes(w))
    .concat(/[\w.+-]+@[\w-]+\.[\w.]+/.test(t) ? ["メールアドレスらしき文字列"] : []);
  return {blanks, banned: BANNED.filter(w => t.includes(w)), jargon: JARGON.filter(w => t.includes(w)),
    left: LEFTOVER.filter(w => t.includes(w)), emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t), contact, len: t.replace(/\s/g,"").length};
}

/* ---------- 文字起こしの切り出し（冒頭3分＋最後2分） ---------- */
function trimTranscript(raw){
  const lines = String(raw||"").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const toS = t => { const p = t.split(":").map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };
  const segs = []; let cur = null, chap = "";
  for (const ln of lines){
    const m = ln.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/);
    if (m){ cur = {t: toS(m[1]), at: m[1], text: (chap ? `［章：${chap}］` : "") + (m[2] || "")}; chap = ""; segs.push(cur); continue; }
    if (/\((自動生成|auto-generated)\)$/.test(ln)) continue;
    if (/^\d+\s*(時間|分|秒)(\s*\d+\s*(分|秒))*$/.test(ln)) continue;
    if (/^(文字起こし|チャプター|タイムライン|動画の関連情報|文字音声変換を検索|Copy Transcript)$/.test(ln)) continue;
    if (cur && cur.text && !/^［章：/.test(cur.text)) { chap = ln; continue; }
    if (cur) cur.text += (cur.text ? " " : "") + ln;
  }
  if (segs.length >= 5){
    const end = segs[segs.length-1].t;
    const head = segs.filter(s => s.t <= 180), tail = segs.filter(s => s.t >= end - 120 && s.t > 180);
    const f = arr => arr.map(s => `${s.at} ${s.text}`).join("\n");
    return {timed: true, text: `【冒頭3分】\n${f(head)}` + (tail.length ? `\n\n【最後の2分（全体は約${Math.round(end/60)}分）】\n${f(tail)}` : ""), kept: head.length + tail.length, total: segs.length};
  }
  const s = lines.join("\n");
  return {timed: false, text: s.length > 9000 ? s.slice(0, 6500) + "\n\n（中略）\n\n" + s.slice(-2500) : s, kept: 0, total: 0};
}

/* ---------- Claude に渡す指示文 ---------- */
const AUD = "文字起こしは音声だけ。画面にテロップや図解が出ているかは分からないので「音声のみ」「字幕なし」「文字が出ていない」「間延びして見える」のような見た目・テンポの断定はしない。見た目の提案は「ここで◯◯の文字を出します」と自分がやることとして書く。話の順番・言葉の中身・情報量など、文字起こしから確かに言えることだけを気づきにする。";
const RULES = `あなたは動画編集者の営業文を書く「AIM案件獲得ブレイン」です。以下の規則を必ず守る。
- ユーザー自身の情報は、下の「プロフィール」にある項目だけ使う。無い項目（単価・稼働時間・着手可能日・連絡先・ポートフォリオ等）は必ず【　　】で空欄にする。推測で埋めない。プロフィールに無い対応範囲・経験・スキルを書き足さない。
- 動画の要約・内容まとめ・チャプターは書かない。
- 指摘は「分析」にある秒数・動画タイトル付きのものだけ使う。分析に無い秒数を作らない。実在確認できない固有名詞を作らない。
- 「▼ 御社の動画を拝見して」ブロックの指摘は2つまで。各指摘のあとに必ず「自分が何をするか」を1行。「直すと何が変わるか」を平易な言葉で添える（最後まで見る人が増える／サムネが押される／申し込みが来る／撮り直しが減る）。
- 撮影（カメラ・照明・映り込み）には触れない。
- 使わない言葉：拝見いたしました／拝見しました（見出しの「▼ 〜を拝見して」だけは可。本文は「見ました」）／〜と感じました／非常に／〜と思います／ご検討いただけますと幸いです／改善できる点として／〜が見込めます。「褒める→ですが→指摘」の構文も禁止。
- 専門用語は言い換える：視聴維持率→最後まで見られる率、離脱→途中で閉じられる、CTA→最後の一言、ファーストビュー→最初の1秒。
- 絵文字を使わない。量を送ることを勧めない。満たしていない募集条件を満たしているように書かない（不明な条件は【　　】）。
- 3パターンは1行目の入り方で変える。A=実績（本数とジャンル）から入る5行前後。B=「はじめまして」＋名乗り＋募集要項への回答＋動画についての段落、400字前後。C=チャンネル・動画の良い点を具体的に1つ挙げてから入る300字前後。
- 締めの1文は毎回変える（例：まず1本、試させてください／実際の動画で見た方が早いので、1本作らせてください）。署名は【媒体のルール】に従う。
- 相手が個人の依頼主なら「▼ 動画を拝見して」にしてよい。`;

function profileText(){
  const p = S.profile || {};
  return `名前：${p.name||"【　　】"}\n職種：${p.title||"【　　】"}\n得意：${p.skills||"【　　】"}\n使用ソフト：${p.tools||"【　　】"}\n実績：${p.achievement||"【　　】"}${p.portfolio?`\nポートフォリオ：${p.portfolio}`:""}`;
}
function draftPrompt(j){
  const a0 = S.analyses[j.id], a = own(a0), r = a0?.ref, k = mkey(j);
  const reqs = (j.requirements||[]).map(c => `- ${c.label}${c.note?`（${c.note}）`:""}`).join("\n");
  let an = "相手のチャンネルの分析なし。相手の動画への指摘は書かない（「▼ 御社の動画を拝見して」ブロックは出さない）。";
  if (a){
    const L = [`見た動画：「${a.video?.title}」`];
    if (!a.verified) L.push("※動画の中身は未確認。指摘部分は【　★冒頭30秒を見て、気になった箇所を秒数付きで1つ　】【　★自分ならどう直すか1行　】の2行の空欄で出す。");
    for (const x of ["hook","main","cta"]) for (const f of (a.axes?.[x]||[])) L.push(`[${x}] ${f.at||""} 気づき：${f.issue}${f.action?` ／やること：${f.action}`:""}${f.effect?` ／変わること：${f.effect}`:""}`);
    if (a.axes?.good) L.push(`良い点：${a.axes.good}`);
    an = L.join("\n");
  }
  let ra = "";
  if (r?.verified){
    const L = [`【参考動画の分析】※依頼主のチャンネルではない。依頼主が「この作りで」と指定した見本。`, `見本：「${r.video?.title||""}」`];
    if (r.summary) L.push(`見本の型：${r.summary}`);
    for (const pt of (r.points||[])) L.push(`- ${pt.at||""} 見本の作り：${pt.what}${pt.reproduce?` ／自分がやること：${pt.reproduce}`:""}${pt.why?` ／効いている理由：${pt.why}`:""}`);
    L.push("参考動画の使い方：パターンBでは「▼ 参考動画を拝見して」ブロックを作り、上の点から2つまで、秒数つきで「見本の◯:◯◯の〜を、こう再現します」と書く。パターンCは見本の良い点を1つ挙げて入る。見本を依頼主の動画であるかのように書かない。見本へのダメ出しはしない。");
    ra = "\n\n" + L.join("\n");
  } else if (j.refVideos?.length){ ra = "\n\n【参考動画】指定はあるが未分析。中身に触れない。"; }
  const q = (j.formQuestions||[]).map((s,i) => `${i+1}. ${s}`).join("\n");
  const mediaRule = k === "indeed"
    ? "媒体：Indeed。応募フォームの自由記入欄に貼る文面。署名は名前と【連絡先】。"
    : `媒体：${M(j).name}。サイト内の応募フォームに貼る文面。規約により契約前の外部連絡先（メール・LINE・電話・Chatwork ID 等）は絶対に書かない。署名は名前だけにし【連絡先】も入れない。金額と納期はフォームの別欄に入力するので本文では触れなくてよい。ポートフォリオURLは本文に入れてよい。`;
  const qRule = q ? `\n依頼主が指定した応募項目（パターンBでは「▼ 募集要項への回答」をこの番号順で全部書く。プロフィールで答えられない項目は【　　】）：\n${q}` : "";
  const noC = !((a && a.verified) || r?.verified);
  const tone = S.tone === "A" ? "きっちり敬語" : "少しやわらかめ（丁寧語は保ちつつ、硬すぎない）";
  return `${RULES}

トーン：${tone}
${S.instr ? `追加の指示：${S.instr}\n` : ""}
【媒体のルール】
${mediaRule}${qRule}

【プロフィール】
${profileText()}

【案件】
会社・依頼主：${j.company}
案件：${j.title}
単価：${j.tanka}${j.priceNote?`\n金額の指定：${j.priceNote}`:""}
募集要項の要点：${j.summary||""}
応募条件（プロフィールと照らして、満たすものだけ満たすと書く。分からないものは【　　】）：
${reqs}

【相手のチャンネルの分析】
${an}${ra}

出力：次の形のJSONだけを返す（前後に説明を書かない）。
{"A":"パターンAの本文","B":"パターンBの本文","C":${noC ? `""` : `"パターンCの本文"`},"recommend":"A|B|C のどれか","reason":"推奨理由を1行"}
推奨の基準：募集要項があり文字数に余裕→B／実績があり応募者が多そう→A／募集が出ておらずこちらから声をかける→C。本文中の改行は\\nで表す。`;
}
function axesPrompt(j, memo){
  const a = own(S.analyses[j.id]); const tr = trimTranscript(memo);
  return `動画編集者が相手の動画を見て書いたメモ（または文字起こし）を、営業用の分析に整理する。
規則：メモに書かれていない秒数・内容を作らない。要約はしない。${AUD}各軸の指摘は効果の大きい順に最大2つ。各指摘は「気づき／自分がやること（道具・数値レベル。例：文字を1.5倍にして黒帯を敷く、間を0.2秒詰める）／変わること（最後まで見る人が増える・サムネが押される・申し込みが来る・撮り直しが減る のどれか）」にする。専門用語は使わない。
動画タイトル：${a?.video?.title || "（不明）"}
案件：${j.company}「${j.title}」

${tr.timed ? "以下は動画の文字起こし（秒数つき・冒頭3分と最後2分）。文字起こしにある秒数だけを使う。HOOKは冒頭、CTAは最後の部分から拾う。" : "以下は編集者のメモ。"}
${tr.text.slice(0, 15000)}

次のJSONだけを返す（前後に説明を書かない）：{"hook":[{"at":"0:00〜0:12","issue":"","action":"","effect":""}],"main":[...],"cta":[...],"good":"良い点を1つ（無ければ空文字）"}`;
}
function refPrompt(j, memo){
  const tr = trimTranscript(memo);
  return `動画編集者が、依頼主から「この作りで編集してほしい」と指定された参考動画（見本）の文字起こし、またはメモを、「再現ポイント」に整理する。
規則：書かれていない秒数・内容を作らない。要約はしない。見本へのダメ出しはしない。${AUD}各ポイントは「見本の作り／自分がやること（道具・数値レベル）／効いている理由（平易に）」。最大4つ。専門用語は使わない。
案件：${j.company}「${j.title}」
参考動画：${(j.refVideos||[]).map(v=>v.title||v.url).join(" / ")}

${tr.timed ? "以下は見本の文字起こし（秒数つき・冒頭3分と最後2分）。話の組み立て（問いの出し方・答えの順番・目次・締め方）から再現ポイントを拾う。" : "以下は編集者のメモ。"}
${tr.text.slice(0, 15000)}

次のJSONだけを返す（前後に説明を書かない）：{"summary":"見本の型を1文で","points":[{"at":"0:11","what":"","reproduce":"","why":""}]}`;
}
function addJobPrompt(url, text){
  return `動画編集の募集ページの本文を、案件カードの形に整理する。
規則：本文に書かれていないことを作らない。金額・条件は本文の表記どおり。個人の依頼主の本名は書かず「個人の依頼主」とする。
募集ページURL：${url}

本文：
${text.slice(0, 15000)}

次のJSONだけを返す（前後に説明を書かない）：
{"media":"Indeed|クラウドワークス|ランサーズ|その他","company":"会社名または「個人の依頼主」","title":"案件名（40字以内）","tanka":"単価（本文どおり）","summary":"仕事内容・本数・納期の要点を100字以内","requirements":[{"label":"応募条件1つ"}],"formQuestions":["依頼主が応募時に書いてほしいと指定した項目（無ければ空配列）"],"refVideos":[{"url":"参考動画のURL（無ければ空配列）","title":""}],"deadline":"締切（分かれば）"}`;
}

/* 返ってきた答えをJSONとして読む */
function parseReply(t){
  let s = String(t || "").trim();
  const f = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) s = f[1].trim();
  const i = s.search(/[\[{]/), k = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (i < 0 || k < i) throw new Error("JSON が見つかりません");
  return JSON.parse(s.slice(i, k + 1));
}

/* ---------- 画面 ---------- */
function render(){
  document.querySelectorAll(".step").forEach(b => b.setAttribute("aria-current", b.dataset.step === S.step ? "step" : "false"));
  const m = S.meta || {};
  $("#f-col").textContent = m.collected ?? "—";
  $("#f-cand").textContent = allJobs().length || "—";
  $("#f-a").textContent = allJobs().filter(j => j.group === "A" || j.refVideos?.length).length || "—";
  $("#f-pick").textContent = picked().length;
  const main = $("#main");
  const focusId = document.activeElement?.id;
  if (S.step === "profile") main.innerHTML = viewProfile();
  else if (!S.profile && S.step !== "pick") main.innerHTML = needProfile();
  else if (S.loadErr && !S.base.length) main.innerHTML = `<div class="empty"><b>読み込めませんでした</b>${esc(S.loadErr)}</div>`;
  else main.innerHTML = S.step === "pick" ? viewPick() : S.step === "analyze" ? viewAnalyze() : viewWrite();
  bind();
  if (focusId && $("#" + focusId)) { const el = $("#" + focusId); el.focus(); }
}
function needProfile(){
  return `<div class="empty"><b>最初にプロフィールを登録してください</b>営業文は、あなたの名前と実績を使って書きます。登録した内容はこのブラウザの中だけに保存され、どこにも送られません。<div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-go="profile">プロフィールを登録する</button></div></div>`;
}
function viewProfile(){
  const p = S.profile || {};
  const f = (id, label, ph, val, hint="") => `<div class="pf"><label for="${id}">${label}</label><input type="text" id="${id}" value="${esc(val||"")}" placeholder="${esc(ph)}">${hint?`<small>${hint}</small>`:""}</div>`;
  return `<div class="view-head"><div class="grow"><h2>あなたのプロフィール</h2>
    <p>営業文の名乗りと実績に使います。<b>このブラウザの中だけに保存</b>され、サーバーには送られません。単価と稼働時間は案件ごとに変わるので、ここでは聞きません（営業文では【　】で残ります）。</p></div></div>
  <section class="card"><div class="pform">
    ${f("pf-name","お名前","例）山田花子",p.name)}
    ${f("pf-title","職種・肩書き","例）YouTube動画編集者",p.title)}
    ${f("pf-skills","得意なこと","例）YouTubeの長尺編集、ショート／リール動画",p.skills)}
    ${f("pf-tools","使用ソフト・機材","例）Premiere Pro",p.tools)}
    ${f("pf-ach","実績（本数とジャンルで）","例）ビジネス系YouTube 10本、リール 30本",p.achievement,"「◯ヶ月」ではなく「◯本」で。盛らずに実数で書いてください。")}
    ${f("pf-pf","ポートフォリオURL（任意）","https://",p.portfolio)}
    ${f("pf-ex","リストから外す会社（任意）","例）いまお取引中の会社名（読点区切り）",(p.exclude||[]).join("、"),"今の取引先に営業してしまう事故を防ぎます。")}
  </div>
  <div class="row" style="margin-top:16px"><button class="btn primary" data-act="save-profile">保存する</button>
  ${S.profile ? `<button class="btn ghost" data-go="pick">案件リストへ</button>` : ""}</div></section>
  <section class="card"><span class="eyebrow">Claude API 連携（任意）</span><h3>APIキーを登録して、ボタン1つで分析・営業文づくり</h3>
    <p class="quiet">登録すると「Claude で分析する」「Claude で営業文を書く」ボタンが使えるようになり、コピー＆貼り付けが要らなくなります。利用料はご自身の Anthropic アカウントに請求されます（使用モデル：Claude Opus 5。目安は1回あたり十数円〜数十円／推定）。</p>
    <ol class="quiet" style="font-size:14px;margin:8px 0;padding-left:1.3em">
      <li><a href="https://console.anthropic.com/" target="_blank" rel="noopener">Anthropic のコンソール</a>に登録し、クレジットを購入する</li>
      <li>「API Keys」で新しいキーを作り、<b>sk-ant-</b> から始まる文字列をコピーする</li>
      <li>下の欄に貼って保存する</li>
    </ol>
    <div class="row"><input type="password" id="pf-key" autocomplete="off" style="flex:1;min-width:220px" placeholder="sk-ant-..." value="${esc(getKey())}">
      <button class="btn primary sm" data-act="save-key">保存する</button>
      ${getKey() ? `<button class="btn ghost sm" data-act="clear-key">キーを消す</button>` : ""}</div>
    <p class="quiet" style="font-size:13px;margin-top:8px">キーはこのブラウザの中だけに保存され、Claude（api.anthropic.com）への呼び出しにだけ使います。共用のパソコンでは登録しないでください。念のため、コンソールで月の利用上限を設定しておくのがおすすめです。</p>
  </section>
  <section class="card"><span class="eyebrow">データの持ち運び</span><h3>バックアップと引っ越し</h3>
    <p class="quiet">選んだ案件・分析・営業文もこのブラウザに保存されています。別のパソコンに移すときや、念のための控えに使ってください。</p>
    <div class="row" style="margin-top:10px"><button class="btn ghost" data-act="export">データを書き出す</button>
    <label class="btn ghost" for="imp" style="cursor:pointer">データを読み込む</label><input type="file" id="imp" accept="application/json" hidden>
    <button class="btn ghost" data-act="wipe">このブラウザのデータを消す</button></div>
    ${S.error==="wipe" ? `<p class="err">本当に消しますか？ もう一度押すと、プロフィール・分析・営業文がすべて消えます。</p>` : ""}
  </section>`;
}

function stats(j){ return j.applicants!=null || j.deadline ? `<div class="stats">${j.applicants!=null?`<span>応募 <b>${fmt(j.applicants)}</b> 人</span>`:""}${j.deadline?`<span>締切 <b>${esc(j.deadline)}</b></span>`:""}${j.fetchedAt?`<span>${esc(j.fetchedAt)}時点</span>`:""}</div>` : ""; }
function chRecent(ch){
  if (!ch?.recent?.length) return "";
  const max = Math.max(...ch.recent.map(r => r.views));
  return `<div class="bars" aria-label="直近の再生数">${ch.recent.slice().reverse().map(r => `<span style="height:${Math.max(8, Math.round(r.views / max * 40))}px" title="${esc(r.date)} ${fmt(r.views)}回"></span>`).join("")}</div>`;
}
function viewPick(){
  const jobs = allJobs();
  const base = jobs.filter(j => S.media==="all" || mkey(j)===S.media);
  const hasRefOrCh = j => j.group==="A" || j.refVideos?.length;
  const counts = {all: base.length, A: base.filter(hasRefOrCh).length, pick: base.filter(j=>j.status==="pick"||j.status==="sent").length, new: base.filter(j=>j.status==="new").length, skip: base.filter(j=>j.status==="skip").length};
  const mcount = k => k==="all" ? jobs.length : jobs.filter(j=>mkey(j)===k).length;
  const list = base.filter(j => S.filter==="all" ? true : S.filter==="A" ? hasRefOrCh(j) : S.filter==="pick" ? (j.status==="pick"||j.status==="sent") : S.filter==="skip" ? j.status==="skip" : j.status==="new");
  const m = S.meta || {};
  return `
  ${!S.profile ? `<div class="notice" style="margin-bottom:16px"><b>はじめての方へ：</b>案件を選ぶ前後どちらでも大丈夫です。営業文を作る前に <button class="btn primary sm" data-go="profile">プロフィールを登録</button> してください。</div>` : ""}
  <section class="search">
    <div class="search-head"><h3>案件リスト <span class="quiet" style="font-size:13px;font-weight:700">最終更新 ${esc(m.updatedAt || "—")}・Indeed／クラウドワークス／ランサーズから集めています</span></h3>
      <button class="btn ghost sm" data-act="reload">最新のリストを読み込む</button>
      <button class="btn primary sm" data-act="addjob-open">案件を自分で追加</button></div>
    ${S.flow?.kind === "addjob" ? addJobCard() : ""}
    ${m.note ? `<p class="quiet" style="margin-top:8px;font-size:13px">${esc(m.note)}</p>` : ""}
  </section>
  <div class="view-head">
    <div class="grow"><h2>営業したい相手だけ、残す。</h2>
    <p>ピンと来た案件に「営業する」。気が乗らないものは見送り。相手のチャンネルや参考動画が分かっている案件ほど、1通目が強くなります。</p></div>
    <div class="filters">
      <div class="seg" role="group" aria-label="媒体">${[["all","全媒体"],["indeed","Indeed"],["crowdworks","クラウドワークス"],["lancers","ランサーズ"]].map(([k,l]) => `<button data-media="${k}" aria-pressed="${S.media===k}">${l}<span class="n">${mcount(k)}</span></button>`).join("")}</div>
      <div class="seg" role="group" aria-label="絞り込み">${[["all","すべて"],["A","動画あり"],["new","未判断"],["pick","営業する"],["skip","見送り"]].map(([k,l]) => `<button data-filter="${k}" aria-pressed="${S.filter===k}">${l}<span class="n">${counts[k]}</span></button>`).join("")}</div>
    </div>
  </div>
  ${list.length ? `<div class="grid">${list.map(cardJob).join("")}</div>` : `<div class="empty"><b>該当なし</b>絞り込みを変えてください。</div>`}
  ${picked().length ? `<div class="row" style="margin-top:22px;justify-content:flex-end"><button class="btn primary" data-go="analyze">選んだ ${picked().length} 件の動画を分析する →</button></div>` : ""}`;
}
function cardJob(j){
  const st = j.status, ch = j.channel, on = st==="pick"||st==="sent";
  return `<article class="job ${on?"pick":""} ${st==="skip"?"skip":""}">
    <div class="job-top">
      <div class="job-meta">
        ${j.group==="A" ? `<span class="chip a">チャンネル特定済み</span>` : ""}
        ${j.refVideos?.length ? `<span class="chip a" style="background:var(--navy);border-color:var(--navy);color:var(--surface)">参考動画あり</span>` : ""}
        ${j.group!=="A" && !j.refVideos?.length ? `<span class="chip b">募集要項のみ</span>` : ""}
        <span class="chip media" data-m="${mkey(j)}">${esc(M(j).name)}</span>
        ${j.custom ? `<span class="chip">自分で追加</span>` : ""}
        ${st==="sent" ? `<span class="chip sent">応募済み ${esc(j.sentAt)}</span>` : ""}
      </div>
      <span class="co">${esc(j.company)}</span>
      <h3>${esc(j.title)}</h3>
      <div class="pay">${esc(j.tanka)}</div>
      ${stats(j)}
    </div>
    ${ch ? `<div class="ch"><div class="nm"><a href="${esc(ch.url)}" target="_blank" rel="noopener">${esc(ch.name)}</a></div>${chRecent(ch)}
        <div class="subs">登録 ${esc(ch.subs)}・最終投稿 ${esc(ch.lastPost)}</div>
        <div class="cap">直近 ${(ch.recent||[]).map(r=>fmt(r.views)).join(" / ")} 回（${esc(ch.fetchedAt||"")}時点）</div></div>`
      : `<div class="ch none">${j.refVideos?.length ? "依頼主が参考動画を指定しています。見本の作りを読んで提案できます。" : "相手のチャンネルは見つかっていません。募集要項への回答で勝負します。"}</div>`}
    <div class="conds">${(j.requirements||[]).map(c => `<span class="chip ${c.warn?"ng":"unknown"}" title="${esc(c.note||"")}">${esc(c.label)}${c.note && c.warn ? "：" + esc(c.note) : ""}</span>`).join("")}</div>
    <div class="job-act">
      <button class="btn ${on?"on":"primary"} sm" data-status="pick" data-id="${esc(j.id)}">${on?"営業する ✓":"営業する"}</button>
      <button class="btn ghost sm" data-status="skip" data-id="${esc(j.id)}">${st==="skip"?"見送りを取り消す":"見送る"}</button>
      ${j.custom ? `<button class="btn ghost sm" data-act="deljob" data-id="${esc(j.id)}">削除</button>` : ""}
      <a class="link" href="${esc(j.applyUrl)}" target="_blank" rel="noopener">募集ページ</a>
    </div></article>`;
}

/* 「Claude に聞く」共通カード */
const API_LABEL = {axes: "分析する", ref: "再現ポイントを出す", draft: "営業文を書く", addjob: "カードを作る"};
function flowCard(kind, id, prompt, title, doneLabel){
  const active = S.flow && S.flow.kind === kind && S.flow.id === id;
  const hasKey = !!getKey();
  const run = S.running && S.running.kind === kind && S.running.id === id ? S.running : null;
  const manual = manualSteps(kind, id, prompt, doneLabel, active);
  if (!hasKey) return `<div class="flow-box">${manual}
    <p class="quiet" style="font-size:13px;margin:10px 0 0">Anthropic の APIキーを<button class="btn ghost sm" data-go="profile">プロフィール画面</button>で登録すると、この手順がボタン1つになります。</p></div>`;
  return `<div class="flow-box">
    <div class="row">
      <button class="btn primary" data-act="api-run" data-kind="${kind}" data-id="${esc(id)}" ${S.running ? "disabled" : ""}>Claude で${API_LABEL[kind] || "実行する"}</button>
      ${run ? `<span class="thinking"><span class="dot"></span>${run.text ? "書いています…" : "考えています…（30秒〜1分）"}</span><button class="btn ghost sm" data-act="api-stop">止める</button>` : `<span class="quiet" style="font-size:13px">あなたの APIキーで Claude を呼びます</span>`}
    </div>
    ${run && run.text ? `<pre class="prompt" id="live">${esc(run.text.slice(-500))}</pre>` : ""}
    ${active && S.error ? `<p class="err">${esc(S.error)}</p>` : ""}
    <details style="margin-top:10px"><summary>APIを使わずに、コピーして自分の Claude に貼る</summary>${manual}</details>
  </div>`;
}
function manualSteps(kind, id, prompt, doneLabel, active){
  return `<ol class="flow-steps" style="margin-top:8px">
      <li><b>指示文をコピー</b><div class="row"><button class="btn primary sm" data-act="flow-copy" data-kind="${kind}" data-id="${esc(id)}">指示文をコピー</button>
        <details><summary>中身を見る</summary><pre class="prompt">${esc(prompt)}</pre></details></div></li>
      <li><b>自分の Claude に貼って送る</b><div class="row"><a class="btn ghost sm" href="https://claude.ai/new" target="_blank" rel="noopener">Claude を開く</a><span class="quiet" style="font-size:13px">新しいチャットに貼り付けて送信します</span></div></li>
      <li><b>返ってきた答えを全部コピーして、ここに貼る</b>
        <textarea id="reply-${kind}" rows="5" placeholder="Claude の答え（{ から始まる部分）をそのまま貼る">${active ? esc(S.reply) : ""}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn primary" data-act="flow-apply" data-kind="${kind}" data-id="${esc(id)}">${doneLabel}</button></div>
        ${active && S.error && !getKey() ? `<p class="err">${esc(S.error)}</p>` : ""}</li>
    </ol>`;
}
function addJobCard(){
  const f = S.flow || {};
  return `<div style="margin-top:14px">
    <p class="quiet">リストにない募集を見つけたら、URLと募集本文を貼ってください。Claude が案件カードの形に整理します。</p>
    <div class="pform" style="margin-top:8px">
      <div class="pf"><label for="aj-url">募集ページのURL</label><input type="text" id="aj-url" value="${esc(f.url||"")}" placeholder="https://"></div>
      <div class="pf" style="grid-column:1/-1"><label for="aj-text">募集本文（ページの本文をまるごとコピーして貼る）</label><textarea id="aj-text" rows="5">${esc(f.text||"")}</textarea></div>
    </div>
    ${f.url && f.text ? flowCard("addjob", "new", addJobPrompt(f.url, f.text), "", "カードとして追加する") : `<div class="row" style="margin-top:8px"><button class="btn primary sm" data-act="addjob-next">次へ（指示文を作る）</button><button class="btn ghost sm" data-act="flow-close">やめる</button></div>`}
  </div>`;
}

function sideList(){
  return `<nav class="side" aria-label="営業先">${picked().map(j => {
    const a = S.analyses[j.id], d = S.drafts[j.id], o = own(a), r = a?.ref;
    return `<button data-cur="${esc(j.id)}" aria-current="${S.current===j.id}">
      <b>${esc(j.company)}</b><small>${esc(j.title.slice(0,34))}${j.title.length>34?"…":""}</small>
      <span class="state">
        ${j.channel ? (o?.verified ? `<span class="chip ok">相手の動画：分析済み</span>` : `<span class="chip">相手の動画：未分析</span>`) : ""}
        ${j.refVideos?.length ? (r?.verified ? `<span class="chip ok">参考動画：分析済み</span>` : `<span class="chip unknown">参考動画：未分析</span>`) : ""}
        ${d ? `<span class="chip ok">営業文あり</span>` : ""}
        <span class="chip media" data-m="${mkey(j)}">${esc(M(j).name)}</span>
        ${j.status==="sent" ? `<span class="chip sent">応募済み</span>` : ""}
      </span></button>`;}).join("")}</nav>`;
}
function ensureCurrent(){ const l = picked(); if (!l.find(j => j.id === S.current)) S.current = l[0]?.id || null; }
const noPicks = () => `<div class="empty"><b>まだ営業先を選んでいません</b>「01 営業先を選ぶ」で、営業したい案件に「営業する」を押してください。<div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-go="pick">営業先を選ぶ</button></div></div>`;

const AXES = [["hook","① HOOK","冒頭"],["main","② 本編","どこで飽きるか"],["cta","③ CTA","最後の一言"],["material","④ 素材","撮影"],["bench","⑤ ベンチマーク","伸びている型"]];
const HOWTO = `<details class="howto"><summary>文字起こしのコピー手順（1分）</summary><ol>
  <li>YouTube で動画を開き、概要欄の「…もっと見る」を押す</li>
  <li>概要欄のいちばん下の「文字起こしを表示」を<b>自分の手で</b>押す</li>
  <li>右に出たパネルの一番上の行から一番下まで、ドラッグで選んでコピー</li>
  <li>下の欄に貼る。秒数ごと貼ってOK（冒頭3分と最後2分を自動で切り出します）</li></ol>
  <p class="quiet" style="font-size:13px">パネルが空のままの動画（自動吹き替え付きなど）もあります。その場合は、自分で見て気づいたことを秒数つきで書いてください。</p></details>`;
function pasteNote(id){
  const v = S.memo[id]; if (!v || v.length < 200) return "";
  const r = trimTranscript(v);
  return r.timed ? `<p class="reason">文字起こしを認識しました：${r.total}行のうち、冒頭3分と最後2分の${r.kept}行を使います。</p>` : `<p class="reason">秒数が見つからないのでメモとして扱います。</p>`;
}
function viewAnalyze(){
  ensureCurrent(); if (!S.current) return noPicks();
  const j = job(S.current), a = S.analyses[j.id], o = own(a);
  const hasRef = !!j.refVideos?.length;
  return `<div class="view-head"><div class="grow"><h2>相手の動画を、秒数で読む。</h2>
    <p>要約はしません。相手の動画は「どこを直すと、何が変わるか」、参考動画は「どこを再現すれば、相手の期待どおりになるか」だけを拾います。</p></div></div>
  <div class="pane">${sideList()}<div>
    ${j.channel ? ownCard(j, o) : ""}
    ${hasRef ? refCard(j, a?.ref) : ""}
    ${!j.channel && !hasRef ? `<section class="card"><span class="eyebrow">相手の動画</span><h3>チャンネルも参考動画も見つかっていません</h3>
      <p class="quiet">募集要項への回答で勝負します。相手の YouTube チャンネルを自分で見つけたら、下にURLを入れると分析できるようになります。</p>
      <div class="row" style="margin-top:8px"><input type="text" id="own-ch" placeholder="https://www.youtube.com/@..."><button class="btn ghost sm" data-act="set-ch">相手のチャンネルとして登録</button></div></section>` : ""}
    ${reqCard(j)}
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button class="btn primary" data-go="write">この分析で営業文をつくる →</button></div>
  </div></div>`;
}
function finding(f){ return `<div class="finding">${f.at ? `<span class="ts">${esc(f.at)}</span>` : ""}<dl class="flow"><dt>気づき</dt><dd>${esc(f.issue)}</dd>${f.action?`<dt>自分がやる</dt><dd>${esc(f.action)}</dd>`:""}${f.effect?`<dt>変わること</dt><dd class="eff">${esc(f.effect)}</dd>`:""}</dl></div>`; }
function ownCard(j, o){
  const key = j.id;
  const showMemo = !o?.verified || S.redo[key];
  const ax = o?.axes || {};
  const url = j.channel?.url || "";
  return `<section class="card">
    <span class="eyebrow">相手のチャンネル</span>
    <h3>${o?.verified ? esc(o.video?.title || "分析した動画") : "相手の動画を1本選んで分析する"}</h3>
    <p class="quiet"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(j.channel?.name || url)}</a> の最近の動画から、1本選んでください。</p>
    ${o?.verified && !S.redo[key] ? `<div style="margin-top:8px">${AXES.map(([k,name,sub]) => {
        let body;
        if (k === "material") body = `<p class="quiet">映像はこちらでは確認できません。ご自身の目で30秒早送りして見てください（カメラの高さ・明るさ・映り込み）。</p>`;
        else if (k === "bench") body = `<p class="quiet">同じジャンルで伸びている動画の冒頭15秒を3本見て、共通点を1つ拾ってください。</p>`;
        else body = ax[k]?.length ? ax[k].map(finding).join("") : `<p class="quiet">指摘なし</p>`;
        return `<div class="axis"><div class="axis-name">${name}<small>${sub}</small></div><div>${body}</div></div>`; }).join("")}
      ${ax.good ? `<p class="reason">良い点：${esc(ax.good)}</p>` : ""}
      <div class="row" style="margin-top:10px"><button class="btn ghost sm" data-act="redo" data-key="${esc(key)}">分析し直す</button></div></div>` : ""}
    ${showMemo ? `<div class="pf" style="margin-top:10px"><label for="vtitle">分析する動画のタイトル</label><input type="text" id="vtitle" value="${esc(S.memo[key + ".title"] || o?.video?.title || "")}" placeholder="動画のタイトルをそのまま"></div>
      ${HOWTO}
      <textarea id="memo" data-key="${esc(key)}" rows="7" placeholder="ここに文字起こし、またはメモを貼る">${esc(S.memo[key] || "")}</textarea>
      ${pasteNote(key)}
      ${(S.memo[key]||"").trim() ? flowCard("axes", key, axesPrompt(j, S.memo[key]), "", "分析を反映する") : ""}` : ""}
  </section>`;
}
function refPoint(p){ return `<div class="finding">${p.at ? `<span class="ts">${esc(p.at)}</span>` : ""}<dl class="flow"><dt>見本の作り</dt><dd>${esc(p.what)}</dd>${p.reproduce?`<dt>自分がやる</dt><dd>${esc(p.reproduce)}</dd>`:""}${p.why?`<dt>効いている理由</dt><dd class="eff">${esc(p.why)}</dd>`:""}</dl></div>`; }
function refCard(j, r){
  const key = j.id + ".ref";
  const showMemo = !r?.verified || S.redo[key];
  return `<section class="card">
    <span class="eyebrow">依頼主が指定した参考動画</span>
    <h3>${r?.verified && !S.redo[key] ? esc(r.video?.title || "参考動画") : "参考動画を分析する"}</h3>
    <ul style="margin:8px 0;padding-left:1.2em">${(j.refVideos||[]).map(v => `<li><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title || v.url)}</a>${v.note?`<small style="display:block;color:var(--muted);font-size:12px">${esc(v.note)}</small>`:""}</li>`).join("")}</ul>
    <p class="notice">これは依頼主のチャンネルではなく「この雰囲気で作ってほしい」という見本です。営業文では、見本のどこを再現するかを秒数で示します。</p>
    ${r?.verified && !S.redo[key] ? `${r.summary ? `<p style="margin:12px 0 4px">${esc(r.summary)}</p>` : ""}<div style="margin-top:10px">${(r.points||[]).map(refPoint).join("")}</div>
      <div class="row" style="margin-top:10px"><button class="btn ghost sm" data-act="redo" data-key="${esc(key)}">見本を分析し直す</button></div>` : ""}
    ${showMemo ? `${HOWTO}
      <textarea id="refmemo" data-key="${esc(key)}" rows="6" placeholder="ここに見本の文字起こし、またはメモを貼る">${esc(S.memo[key] || "")}</textarea>
      ${pasteNote(key)}
      ${(S.memo[key]||"").trim() ? flowCard("ref", key, refPrompt(j, S.memo[key]), "", "再現ポイントを反映する") : ""}` : ""}
  </section>`;
}
function reqCard(j){
  return `<section class="card"><span class="eyebrow">募集要項との突き合わせ</span><h3>応募条件</h3>
    <p class="quiet">自分が満たしているかを確認してください。満たしていない条件を、満たしているように書くのは禁止です。</p>
    <div class="req">${(j.requirements||[]).map(c => `<div><span>${esc(c.label)}${c.note?`<small style="display:block;color:var(--muted);font-size:12px">${esc(c.note)}</small>`:""}</span><span class="chip ${c.warn?"ng":"unknown"}">${c.warn?"要注意":"要確認"}</span></div>`).join("")}</div></section>`;
}

function ruleBox(j){
  const k = mkey(j), q = (j.formQuestions||[]);
  const common = q.length ? `<li>依頼主が指定した応募項目（${q.length}つ）に全部答える形で書きます。未記入があると選考対象外になる案件が多いです。</li>` : "";
  if (k === "indeed") return `<div class="rule"><b>Indeed で送るとき</b><ul>${common}<li>応募フォームの自由記入欄に貼ります。署名の【連絡先】は自分で埋めてください。</li></ul></div>`;
  const nm = M(j).name;
  return `<div class="rule"><b>${nm}で送るとき</b><ul>${common}
    <li><b>契約前に、メール・LINE・電話などの外部連絡先は書かない。</b>${nm}の規約で禁止されています。やり取りはサイト内のメッセージで行います。</li>
    <li>${k==="crowdworks" ? "契約金額（税込）と完了予定日は、応募フォームの欄に入力します。" : "提案金額と納期は、提案フォームの欄に入力します。"}${j.priceNote ? `この案件は「${esc(j.priceNote)}」と指定があります。` : ""}</li>
    <li>ポートフォリオのURLは本文に入れて構いません。</li></ul></div>`;
}
const PAT = {A:["A","実績訴求","数字から入る・5行前後"],B:["B","課題指摘","募集要項に答える・400字前後"],C:["C","共感","良いところから入る・300字前後"]};
function viewWrite(){
  ensureCurrent(); if (!S.current) return noPicks();
  const j = job(S.current), a0 = S.analyses[j.id], a = own(a0), r = a0?.ref, d = S.drafts[j.id];
  const canC = !!((a && a.verified) || (r && r.verified));
  const text = d?.patterns?.[S.tab] ?? "";
  return `<div class="view-head"><div class="grow"><h2>1通目の角度を、上げる。</h2>
    <p>指示文をあなたの Claude に貼ると、分析と募集要項から3パターンを書きます。貼り戻したら編集でき、右側で送信前チェックが走ります。</p></div></div>
  <div class="pane">${sideList()}<div>
    <section class="card">
      <span class="eyebrow">${esc(j.company)}</span><h3>${esc(j.title)}</h3>
      <div class="row" style="margin-top:12px">
        <div class="seg" role="group" aria-label="トーン"><button data-tone="A" aria-pressed="${S.tone==="A"}">きっちり敬語</button><button data-tone="B" aria-pressed="${S.tone==="B"}">少しやわらかめ</button></div>
        <input type="text" id="instr" style="flex:1;min-width:200px" placeholder="追加の指示（例：もっと短く）" value="${esc(S.instr)}">
      </div>
      ${ruleBox(j)}
      ${!S.profile ? `<p class="err">プロフィールが未登録です。<button class="btn primary sm" data-go="profile">登録する</button></p>` : ""}
      ${flowCard("draft", j.id, draftPrompt(j), "", d ? "営業文を差し替える" : "営業文を反映する")}
    </section>
    ${d ? `<div class="compose" style="margin-top:16px">
      <section class="card">
        <div class="tabs" role="tablist">${["A","B","C"].map(k => { const dis = k==="C" && !(canC && d.patterns?.C); return `<button class="tab" role="tab" data-tab="${k}" aria-selected="${S.tab===k}" ${dis?"disabled style='opacity:.4'":""}>${d.recommend===k?`<span class="rec">推奨</span>`:""}<b>${PAT[k][0]}｜${PAT[k][1]}</b><small>${PAT[k][2]}</small></button>`; }).join("")}</div>
        ${d.recommend===S.tab && d.reason ? `<p class="reason">推奨の理由：${esc(d.reason)}</p>` : ""}
        <textarea id="draft" class="draft" spellcheck="false">${esc(text)}</textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="copy" ${!text?"disabled":""}>コピーする</button>
          <button class="btn ${j.status==="sent"?"on":"ghost"}" data-status="sent" data-id="${esc(j.id)}">${j.status==="sent"?"応募済み ✓":M(j).sent}</button>
          <a class="link" href="${esc(j.applyUrl)}" target="_blank" rel="noopener">${M(j).apply}</a>
        </div></section>
      <aside><section class="card"><span class="eyebrow">送信前チェック</span><div class="checks" style="margin-top:10px" id="checks">${checksHtml(lint(text), j)}</div></section>
        <div class="pledge"><b>送信は、必ず自分の手で。</b><br>このサイトは応募ボタンを押しません。各サイトは自動操作を規約で禁止しています。コピーして、自分で貼って、自分で送ってください。<br><br><b>10通コピペより、3通ちゃんと。</b></div></aside>
    </div>` : ""}
  </div></div>`;
}
function checksHtml(L, j){
  const c = (cls, title, sub, hits="") => `<div class="check ${cls}"><span class="mk">${cls==="ok"?"✓":"!"}</span><p>${title}<small>${sub}</small>${hits}</p></div>`;
  const hits = arr => arr.length ? `<span class="hits">${arr.map(w=>`<span>${esc(w)}</span>`).join("")}</span>` : "";
  const noContact = j && !M(j).contactOk;
  return [
    L.blanks ? c("warn", `【　】が ${L.blanks} 個あります`, "全部、自分で埋めてから送る。単価・稼働・連絡先はこちらで埋めません。") : c("ok","【　】は残っていません","埋めた数字が他の応募と食い違っていないかだけ確認。"),
    L.left.length ? c("ng","指示文が本文に残っています","消してから送る。", hits(L.left)) : c("ok","指示文の消し忘れなし",""),
    L.banned.length ? c("ng","AIっぽい定型文があります","言い換える。1点だけ具体的に書く。", hits(L.banned)) : c("ok","定型文なし",""),
    L.jargon.length ? c("warn","専門用語があります","例：離脱→途中で閉じられる", hits(L.jargon)) : c("ok","専門用語なし",""),
    L.emoji ? c("ng","絵文字が入っています","営業文では使わない。") : c("ok","絵文字なし",""),
    ...(noContact ? [L.contact.length ? c("ng","外部連絡先が書かれています",`${M(j).name}では契約前の連絡先交換は規約違反です。`, hits(L.contact)) : c("ok","外部連絡先なし",`${M(j).name}の規約に沿っています。`)] : []),
    c("ok", `本文 ${L.len} 字`, "A=5行前後／B=400字前後／C=300字前後が目安"),
  ].join("");
}

/* ---------- 操作 ---------- */
function promptFor(kind, id){
  if (kind === "addjob") return addJobPrompt(S.flow?.url || "", S.flow?.text || "");
  if (kind === "draft") return draftPrompt(job(id));
  const jid = id.replace(/\.ref$/, "");
  return kind === "axes" ? axesPrompt(job(jid), S.memo[id]) : refPrompt(job(jid), S.memo[id]);
}
async function copyText(t, okMsg){
  try { await navigator.clipboard.writeText(t); toast(okMsg); }
  catch(e){ const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast(okMsg); } catch(_){ toast("コピーできませんでした。中身を見るから手でコピーしてください"); } ta.remove(); }
}
/* ---------- Anthropic API（使う人のキーで、ブラウザから直接） ---------- */
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm";
const MODEL = "claude-opus-5";
let AnthropicSDK = null, liveStream = null;
function getKey(){ return LS.get("apikey", ""); }
async function loadSDK(){ if (!AnthropicSDK) AnthropicSDK = (await import(SDK_URL)).default; return AnthropicSDK; }
async function runClaude(kind, id){
  const key = getKey(); if (!key) { go("profile"); return; }
  const prompt = promptFor(kind, id);
  S.flow = {...(S.flow||{}), kind, id}; S.error = ""; S.running = {kind, id, text: ""}; render();
  let A;
  try { A = await loadSDK(); }
  catch(e){ S.running = null; S.error = "Claude の部品を読み込めませんでした。通信環境を確認して、もう一度押してください。"; render(); return; }
  try{
    const client = new A({apiKey: key, dangerouslyAllowBrowser: true});
    liveStream = client.beta.messages.stream({
      model: MODEL, max_tokens: 16000,
      thinking: {type: "adaptive"},
      output_config: {effort: kind === "draft" ? "high" : "medium"},
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      messages: [{role: "user", content: prompt}],
    });
    liveStream.on("text", delta => {
      if (!S.running) return;
      const first = !S.running.text; S.running.text += delta;
      const el = $("#live"); if (el) el.textContent = S.running.text.slice(-500); else if (first) render();
    });
    const msg = await liveStream.finalMessage();
    liveStream = null; S.running = null;
    if (msg.stop_reason === "refusal"){ S.error = "Claude がこの内容の作成を断りました。文字起こしやメモの内容を見直してください。"; render(); return; }
    if (msg.stop_reason === "max_tokens"){ S.error = "答えが長すぎて途中で切れました。追加の指示に「短く」と入れて、もう一度押してください。"; render(); return; }
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    applyReplyText(kind, id, text);
  }catch(e){
    liveStream = null; S.running = null;
    if (e instanceof A.APIUserAbortError) S.error = "止めました。";
    else if (e instanceof A.AuthenticationError) S.error = "APIキーが正しくありません。プロフィール画面で登録し直してください。";
    else if (e instanceof A.PermissionDeniedError) S.error = "この APIキーでは Claude を使えません。Anthropic のコンソールでキーの権限を確認してください。";
    else if (e instanceof A.RateLimitError) S.error = "呼び出しが集中しているか、利用上限に達しました。少し時間をおいてから押してください。";
    else if (e instanceof A.BadRequestError) S.error = /credit|balance/i.test(e.message || "") ? "API のクレジット残高が足りません。Anthropic のコンソールでクレジットを追加してください。" : "Claude に渡す内容に問題がありました：" + (e.message || "").slice(0, 160);
    else if (e instanceof A.APIConnectionError) S.error = "Claude に接続できませんでした。通信環境を確認して、もう一度押してください。";
    else if (e instanceof A.APIError) S.error = "Claude 側でエラーが起きました（" + (e.status || "") + "）。少し時間をおいてから押してください。";
    else S.error = "うまくいきませんでした。もう一度押してください。";
    render();
  }
}
function saveKey(){
  const v = ($("#pf-key")?.value || "").trim();
  if (v && !/^sk-ant-/.test(v)){ toast("sk-ant- で始まるキーを貼ってください"); return; }
  LS.set("apikey", v); toast(v ? "APIキーを保存しました（このブラウザの中だけ）" : "APIキーを消しました"); render();
}
function applyReply(kind, id){ applyReplyText(kind, id, $("#reply-" + kind)?.value || ""); }
function applyReplyText(kind, id, t){
  S.flow = {...(S.flow||{}), kind, id}; S.reply = t; S.error = "";
  let res;
  try { res = parseReply(t); } catch(e){ S.error = "答えの形が読めませんでした。Claude の答えの { から } までを、そのまま全部貼ってください。"; render(); return; }
  if (kind === "draft"){
    if (typeof res.B !== "string"){ S.error = "パターンBが見つかりません。答えを全部貼ってください。"; render(); return; }
    S.drafts[id] = {patterns:{A:String(res.A||""),B:String(res.B||""),C:String(res.C||"")}, recommend: ["A","B","C"].includes(res.recommend) ? res.recommend : "B", reason: String(res.reason||""), at: new Date().toISOString()};
    S.tab = S.drafts[id].recommend; save("drafts"); toast("営業文を反映しました");
  } else if (kind === "axes"){
    const cur = S.analyses[id] || {};
    S.analyses[id] = {...cur, verified: true, video: {title: S.memo[id + ".title"] || cur.video?.title || "（あなたが選んだ動画）"}, axes: {hook: res.hook||[], main: res.main||[], cta: res.cta||[], good: res.good||""}};
    S.redo[id] = false; save("analyses"); toast("分析を反映しました");
  } else if (kind === "ref"){
    const jid = id.replace(/\.ref$/, ""), j = job(jid), cur = S.analyses[jid] || {};
    S.analyses[jid] = {...cur, ref: {verified: true, summary: String(res.summary||""), points: Array.isArray(res.points) ? res.points.slice(0,4) : [], video: {title: j.refVideos?.[0]?.title || "参考動画"}}};
    S.redo[id] = false; save("analyses"); toast("再現ポイントを反映しました");
  } else if (kind === "addjob"){
    const nj = {id: "my-" + Date.now().toString(36), custom: true, order: 999, media: res.media || "その他", company: res.company || "依頼主", title: res.title || "（無題の案件）",
      tanka: res.tanka || "記載なし", summary: res.summary || "", requirements: Array.isArray(res.requirements) ? res.requirements : [],
      formQuestions: Array.isArray(res.formQuestions) ? res.formQuestions : [], refVideos: (res.refVideos||[]).filter(v => v && v.url),
      deadline: res.deadline || "", applyUrl: S.flow?.url || "", fetchedAt: new Date().toISOString().slice(0,10), group: "B", channel: null};
    S.custom.push(nj); save("custom"); toast("案件を追加しました");
  }
  S.flow = null; S.reply = ""; render();
}
function bind(){
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { S.filter = b.dataset.filter; render(); });
  document.querySelectorAll("[data-media]").forEach(b => b.onclick = () => { S.media = b.dataset.media; render(); });
  document.querySelectorAll("[data-status]").forEach(b => b.onclick = () => setStatus(b.dataset.id, b.dataset.status));
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll("[data-cur]").forEach(b => b.onclick = () => { S.current = b.dataset.cur; S.flow = null; S.error = ""; S.tab = S.drafts[S.current]?.recommend || "B"; render(); });
  document.querySelectorAll("[data-tone]").forEach(b => b.onclick = () => { S.tone = b.dataset.tone; render(); });
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { if (!b.disabled){ S.tab = b.dataset.tab; render(); } });
  const instr = $("#instr"); if (instr) instr.onchange = () => { S.instr = instr.value; render(); };
  ["memo","refmemo"].forEach(idn => { const el = $("#" + idn); if (!el) return;
    const k = el.dataset.key;
    el.oninput = () => { S.memo[k] = el.value; save("memo"); };
    el.onpaste = () => setTimeout(() => { S.memo[k] = el.value; save("memo"); render(); }, 0);
    el.onchange = () => { S.memo[k] = el.value; save("memo"); render(); }; });
  const vt = $("#vtitle"); if (vt) vt.onchange = () => { S.memo[S.current + ".title"] = vt.value; save("memo"); };
  const draft = $("#draft"); if (draft) draft.oninput = () => {
    const d = S.drafts[S.current]; if (d){ d.patterns[S.tab] = draft.value; save("drafts"); }
    $("#checks").innerHTML = checksHtml(lint(draft.value), job(S.current)); };
  const imp = $("#imp"); if (imp) imp.onchange = () => importData(imp.files?.[0]);
  document.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const act = b.dataset.act;
    if (act === "flow-copy") copyText(promptFor(b.dataset.kind, b.dataset.id), "指示文をコピーしました。Claude に貼って送ってください");
    if (act === "flow-apply") applyReply(b.dataset.kind, b.dataset.id);
    if (act === "api-run") runClaude(b.dataset.kind, b.dataset.id);
    if (act === "api-stop") liveStream?.abort();
    if (act === "save-key") saveKey();
    if (act === "clear-key") { const el = $("#pf-key"); if (el) el.value = ""; saveKey(); }
    if (act === "flow-close") { S.flow = null; render(); }
    if (act === "redo") { S.redo[b.dataset.key] = true; render(); }
    if (act === "copy") { const el = $("#draft"); if (el) copyText(el.value, "コピーしました。【　】を埋めてから送ってください"); }
    if (act === "reload") loadJobs(true);
    if (act === "addjob-open") { S.flow = {kind: "addjob", id: "new"}; render(); }
    if (act === "addjob-next") { const url = $("#aj-url")?.value.trim(), text = $("#aj-text")?.value.trim(); if (!url || !text){ toast("URLと本文の両方を入れてください"); return; } S.flow = {kind: "addjob", id: "new", url, text}; render(); }
    if (act === "deljob") { S.custom = S.custom.filter(j => j.id !== b.dataset.id); save("custom"); render(); }
    if (act === "set-ch") { const u = $("#own-ch")?.value.trim(); if (!/^https?:\/\//.test(u||"")) { toast("URLを入れてください"); return; } const j = job(S.current); upsertCustomField(j, {channel: {name: u.replace(/^https?:\/\/(www\.)?/, ""), url: u}, group: "A"}); }
    if (act === "save-profile") saveProfile();
    if (act === "export") exportData();
    if (act === "wipe") { if (S.error === "wipe"){ try { Object.keys(localStorage).filter(k => k.startsWith("aimab.")).forEach(k => localStorage.removeItem(k)); } catch(e){} location.reload(); } else { S.error = "wipe"; render(); } }
  });
}
function upsertCustomField(j, patch){
  if (j.custom){ const c = S.custom.find(x => x.id === j.id); Object.assign(c, patch); save("custom"); }
  else { const ov = LS.get("overrides", {}); ov[j.id] = {...(ov[j.id]||{}), ...patch}; LS.set("overrides", ov); applyOverrides(); }
  render();
}
function applyOverrides(){ const ov = LS.get("overrides", {}); S.base = S.base.map(j => ov[j.id] ? {...j, ...ov[j.id]} : j); }
function saveProfile(){
  const v = id => ($("#" + id)?.value || "").trim();
  const p = {name: v("pf-name"), title: v("pf-title"), skills: v("pf-skills"), tools: v("pf-tools"), achievement: v("pf-ach"), portfolio: v("pf-pf"),
    exclude: v("pf-ex").split(/[、,，]/).map(s => s.trim()).filter(Boolean)};
  if (!p.name || !p.achievement){ toast("お名前と実績は入れてください"); return; }
  S.profile = p; save("profile"); toast("保存しました（このブラウザの中だけ）"); go("pick");
}
function exportData(){
  const data = {v: 1, at: new Date().toISOString(), profile: S.profile, status: S.status, analyses: S.analyses, drafts: S.drafts, memo: S.memo, custom: S.custom, overrides: LS.get("overrides", {})};
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], {type: "application/json"}));
  a.download = "aim-anken-brain-" + new Date().toISOString().slice(0,10) + ".json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(file){
  if (!file) return;
  const r = new FileReader();
  r.onload = () => { try { const d = JSON.parse(r.result); ["profile","status","analyses","drafts","memo","custom"].forEach(k => { if (d[k] != null){ S[k] = d[k]; save(k); } }); if (d.overrides) LS.set("overrides", d.overrides); applyOverrides(); toast("読み込みました"); render(); } catch(e){ toast("このファイルは読み込めませんでした"); } };
  r.readAsText(file);
}
function go(step){ S.step = step; S.flow = null; S.error = ""; LS.set("step", step); render(); window.scrollTo({top:0, behavior:"smooth"}); }
let tt; function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2800); }

document.querySelectorAll(".step").forEach(b => b.onclick = () => go(b.dataset.step));
render();
loadJobs(false).then(applyOverrides).then(render);
})();
