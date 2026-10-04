#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIM 案件ブレイン｜案件リスト（jobs.json）の自動更新

GitHub Actions から毎日実行する（.github/workflows/update-jobs.yml）。
- クラウドワークス・ランサーズの新着を取得し、単価・内容で機械的に絞る
- 手で整えた案件（curated.json：Indeed など）と合体し、締切を過ぎたものは外す
- 依頼主の個人名は載せない（「クラウドワークスの依頼主」などに置き換える）

標準ライブラリだけで動く。ローカルでも `python3 update_jobs.py` で同じ結果になる。
"""
import html
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
NOW = datetime.now(JST)
TODAY = NOW.date()
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
KEYWORDS = ["動画編集", "YouTube 編集", "ショート動画", "リール 編集"]
PAGES = 2
MAX_AUTO = {"crowdworks": 30, "lancers": 20}
FRESH_DAYS = 7  # 公開からこの日数以内の案件だけ載せる

# 動画編集者向けでない・単価が極端に低い・個人情報や出演が前提の案件を外す
NEG = re.compile(r"初心者|未経験|デビュー|主婦|スキマ|学生|キャスト|演者|出演|モデル募集|モニター|撮影のみ|韓国語|英語翻訳|"
                 r"トライアル|経験不問|初めて|スマホでも|Canva|実績作り|挑戦したい|何か始めたい|営業パートナー|拡散|話題化|アナウンサー|切り抜き|2ch|ゆっくり|ずんだもん|反応集|VTuber|Vtuber|台本作成|ライター|サムネイル制作のみ|女性限定|男性限定")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def yen(n):
    return f"{int(n):,}円"


def per_piece(title):
    """タイトルから1本あたりの単価を読む（「1本5,000円」「40,000円/10本」の両方）"""
    m = re.search(r"1本\s*[:：]?\s*([\d,]+)\s*円", title)
    if m:
        return int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s*円\s*[/／]\s*(\d+)\s*本", title)
    if m and int(m.group(2)) > 0:
        return int(m.group(1).replace(",", "")) // int(m.group(2))
    return None


def ref_videos(text):
    urls = re.findall(r"https?://(?:www\.)?(?:youtube\.com/watch\?v=[\w-]{11}|youtu\.be/[\w-]{11}|youtube\.com/@[\w.-]+)", text or "")
    out, seen = [], set()
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append({"url": u, "title": "参考動画（募集文に記載）"})
    return out[:3]


def clean(text, n=110):
    t = re.sub(r"\s+", " ", html.unescape(text or "")).strip()
    t = re.sub(r"https?://\S+", "", t)
    return (t[:n] + "…") if len(t) > n else t


# ---------- クラウドワークス ----------
def crowdworks():
    seen, rows, total = set(), [], 0
    for kw in KEYWORDS:
        for page in range(1, PAGES + 1):
            url = ("https://crowdworks.jp/public/jobs/search?search%5Bkeywords%5D="
                   + urllib.parse.quote(kw) + f"&order=new&page={page}")
            try:
                src = fetch(url)
            except Exception as e:
                print("CW fetch failed", kw, page, e)
                continue
            m = re.search(r'<div id="vue-container" data="([^"]*)"', src)
            if not m:
                continue
            data = json.loads(html.unescape(m.group(1)))
            for x in data.get("searchResult", {}).get("job_offers", []):
                total += 1
                jo = x.get("job_offer", {})
                jid = jo.get("id")
                if not jid or jid in seen:
                    continue
                seen.add(jid)
                rows.append(x)
            time.sleep(1)
    jobs = []
    for x in rows:
        jo, pay, entry = x["job_offer"], x.get("payment") or {}, (x.get("entry") or {}).get("project_entry") or {}
        title = jo.get("title", "")
        if not re.search(r"編集|動画", title) or NEG.search(title):
            continue
        released = (jo.get("last_released_at") or "")[:10]
        expired = jo.get("expired_on") or ""
        try:
            if released and (TODAY - datetime.strptime(released, "%Y-%m-%d").date()).days > FRESH_DAYS:
                continue
            if expired and datetime.strptime(expired, "%Y-%m-%d").date() < TODAY:
                continue
        except ValueError:
            pass
        pp = per_piece(title)
        if "fixed_price_payment" in pay:
            lo, hi = pay["fixed_price_payment"].get("min_budget"), pay["fixed_price_payment"].get("max_budget")
            tanka = (f"1本{yen(pp)}〜（募集タイトルより）" if pp else
                     f"{yen(lo)}〜{yen(hi)}（固定報酬）" if lo and hi else
                     f"〜{yen(hi)}（固定報酬）" if hi else "契約金額は相談")
            ok = pp >= 5000 if pp else ((hi or 0) >= 10000 or not hi)
        elif "hourly_payment" in pay:
            lo = pay["hourly_payment"].get("min_hourly_wage") or 0
            hi = pay["hourly_payment"].get("max_hourly_wage") or 0
            tanka = f"時給{yen(lo)}〜{yen(hi)}" if hi else f"時給{yen(lo)}〜"
            ok = max(lo, hi) >= 2000
        else:
            continue  # タスク・コンペは載せない
        if not ok:
            continue
        digest = jo.get("description_digest", "")
        jobs.append({
            "id": f"cw-{jo['id']}", "auto": True, "media": "クラウドワークス", "group": "B",
            "company": "クラウドワークスの依頼主", "title": title.strip(), "tanka": tanka,
            "summary": clean(digest), "requirements": [], "formQuestions": [],
            "refVideos": ref_videos(digest), "applicants": entry.get("num_application_conditions"),
            "deadline": (f"{int(expired[5:7])}/{int(expired[8:10])}" if len(expired) == 10 else ""),
            "applyUrl": f"https://crowdworks.jp/public/jobs/{jo['id']}", "fetchedAt": TODAY.isoformat(),
            "releasedAt": released, "channel": None,
        })
    jobs.sort(key=lambda j: j["releasedAt"], reverse=True)
    return jobs[:MAX_AUTO["crowdworks"]], total


# ---------- ランサーズ ----------
def lancers():
    seen, jobs, total = set(), [], 0
    for kw in KEYWORDS:
        for page in range(1, PAGES + 1):
            url = "https://www.lancers.jp/work/search?keyword=" + urllib.parse.quote(kw) + f"&sort=started&page={page}"
            try:
                src = fetch(url)
            except Exception as e:
                print("Lancers fetch failed", kw, page, e)
                continue
            # 1件 = /work/detail/<id> のリンクから次のリンクまでの塊
            parts = re.split(r'(?=<a[^>]+href="(?:https://www\.lancers\.jp)?/work/detail/\d+)', src)
            for p in parts:
                m = re.match(r'<a[^>]+href="(?:https://www\.lancers\.jp)?/work/detail/(\d+)[^"]*"[^>]*>(.*?)</a>', p, re.S)
                if not m:
                    continue
                lid = m.group(1)
                text = re.sub(r"<[^>]+>", " ", p)
                text = re.sub(r"\s+", " ", html.unescape(text)).strip()
                title = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(2)))).strip()
                title = re.sub(r"^(NEW\s+)?((初回|\d+回目)\s+)?", "", title).strip()
                if len(title) < 8:
                    continue
                total += 1
                if lid in seen:
                    continue
                seen.add(lid)
                if not re.search(r"編集|動画", title) or NEG.search(title) or "終了" in text[:200]:
                    continue
                price = re.search(r"([\d,]+)\s*円\s*~\s*([\d,]+)\s*円\s*/\s*固定", text) or re.search(r"~\s*([\d,]+)\s*円\s*/\s*固定", text)
                hi = int(price.groups()[-1].replace(",", "")) if price else 0
                lo = int(price.group(1).replace(",", "")) if price and len(price.groups()) == 2 else 0
                pp = per_piece(title)
                if not (pp >= 5000 if pp else hi >= 10000):
                    continue
                tanka = f"1本{yen(pp)}〜（募集タイトルより）" if pp else (f"{yen(lo)}〜{yen(hi)}（固定報酬）" if lo else f"〜{yen(hi)}（固定報酬）")
                body = text.split("固定", 1)[-1] if "固定" in text else text
                body = re.sub(r"^(\s*(経験者優遇|継続依頼あり|長期|高単価|品質重視|スピード重視|スムーズな連絡|大量募集|カンタン|法人可|報酬応相談|納期応相談|本人確認が必要|ランサーズチェックが必要|評価＋以上が必要|レギュラーランク以上が必要|秘密保持確認が必要))+", "", body)
                reqs = [{"label": r} for r in ("本人確認が必要", "ランサーズチェックが必要", "評価＋以上が必要", "レギュラーランク以上が必要") if r in text]
                jobs.append({
                    "id": f"lc-{lid}", "auto": True, "media": "ランサーズ", "group": "B",
                    "company": "ランサーズの依頼主", "title": title, "tanka": tanka,
                    "summary": clean(body), "requirements": reqs, "formQuestions": [],
                    "refVideos": ref_videos(p), "applicants": None, "deadline": "",
                    "applyUrl": f"https://www.lancers.jp/work/detail/{lid}", "fetchedAt": TODAY.isoformat(),
                    "releasedAt": "", "channel": None, "_n": int(lid),
                })
            time.sleep(1)
    jobs.sort(key=lambda j: j["_n"], reverse=True)
    for j in jobs:
        j.pop("_n", None)
    return jobs[:MAX_AUTO["lancers"]], total


def deadline_passed(dl):
    m = re.match(r"(\d{1,2})/(\d{1,2})", dl or "")
    if not m:
        return False
    month, day = int(m.group(1)), int(m.group(2))
    year = TODAY.year if month >= TODAY.month - 6 else TODAY.year + 1
    try:
        return datetime(year, month, day).date() < TODAY
    except ValueError:
        return False


def main():
    with open("curated.json", encoding="utf-8") as f:
        curated = json.load(f)
    def stale(j):  # 手で確認してから3週間たった案件は外す（募集が終わっている可能性が高い）
        try:
            return (TODAY - datetime.strptime(j.get("fetchedAt", ""), "%Y-%m-%d").date()).days > 21
        except ValueError:
            return False
    keep = [j for j in curated["jobs"] if not deadline_passed(j.get("deadline")) and not stale(j)]
    cw, cw_total = crowdworks()
    lc, lc_total = lancers()
    seen = {j["applyUrl"] for j in keep}
    titles = set()
    auto = []
    for j in cw + lc:  # 同じ依頼主が同じ募集を複数出していることがあるので、タイトルでも重複を外す
        if j["applyUrl"] in seen or j["title"] in titles:
            continue
        titles.add(j["title"])
        auto.append(j)
    # 初めてリストに載った日を引き継ぐ（画面の NEW 表示に使う）
    try:
        with open("jobs.json", encoding="utf-8") as f:
            first = {j["applyUrl"]: j.get("firstSeen") for j in json.load(f).get("jobs", [])}
    except (OSError, ValueError):
        first = {}
    for i, j in enumerate(auto):
        j["order"] = 1000 + i
    jobs = keep + auto
    for j in jobs:
        j["firstSeen"] = first.get(j["applyUrl"]) or j.get("firstSeen") or TODAY.isoformat()
    out = {
        "updatedAt": NOW.strftime("%Y-%m-%d %H:%M"),
        "autoUpdate": "毎日 朝6時ごろ（クラウドワークス・ランサーズの新着を自動取得）",
        "collected": cw_total + lc_total + curated.get("collectedManual", 0),
        "bySource": {"クラウドワークス": cw_total, "ランサーズ": lc_total, "Indeed（手動）": curated.get("collectedIndeed", 0)},
        "note": "公開されている募集ページから要点をまとめたものです。自動取得の案件は単価と内容で機械的に絞っています。応募前に必ず元の募集ページで最新の内容を確認してください。",
        "jobs": jobs,
    }
    with open("jobs.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"curated {len(keep)}/{len(curated['jobs'])}  crowdworks {len(cw)} (of {cw_total})  lancers {len(lc)} (of {lc_total})  total {len(jobs)}")


if __name__ == "__main__":

    main()
