// Credit Card Credit Alerts
// Emails you monthly (on the 15th) about any credits with fewer than 20 "Days left".
//
// ── One-time setup ─────────────────────────────────────────────────────────
// 1. Create a Notion integration: https://www.notion.so/my-integrations
//    → copy its "Internal Integration Secret".
// 2. Open your "Credit Card Periodic Credits" database in Notion → ••• menu →
//    Connections → add your integration (so it's allowed to read the DB).
// 3. In Val Town: Settings → Environment Variables → add secrets:
//      NOTION_API_KEY       = your integration secret
//      NOTION_DATABASE_ID   = <your Notion database ID>
// 4. Make this a Cron val with schedule:  0 9 15 * *
//    (9:00 AM on the 15th of every month, in your Val Town account timezone).
// ───────────────────────────────────────────────────────────────────────────

import { email } from "https://esm.town/v/std/email";

const NOTION_API_KEY = Deno.env.get("NOTION_API_KEY");
const DATABASE_ID = Deno.env.get("NOTION_DATABASE_ID");
const TRIGGER_DAYS = 20; // only email if something has fewer than this many days left
const EMAIL_WINDOW = 60; // ...but once we email, include everything under this many days

export default async function () {
  console.log("=== Credit alerts run:", new Date().toISOString(), "===");

  // ── Sanity-check config ────────────────────────────────────────────────
  console.log(
    "NOTION_API_KEY present?",
    !!NOTION_API_KEY,
    NOTION_API_KEY ? `(len ${NOTION_API_KEY.length})` : "",
  );
  console.log("NOTION_DATABASE_ID:", DATABASE_ID);
  if (!NOTION_API_KEY) throw new Error("Missing NOTION_API_KEY env var");
  if (!DATABASE_ID) throw new Error("Missing NOTION_DATABASE_ID env var");

  // ── Fetch rows ─────────────────────────────────────────────────────────
  const rows = await queryAllRows();
  console.log(`Fetched ${rows.length} row(s) from Notion.`);

  if (rows.length === 0) {
    console.warn(
      "No rows returned. Most common cause: the database isn't shared with your " +
        "integration (Notion → DB → ••• → Connections), or NOTION_DATABASE_ID is wrong.",
    );
    return;
  }

  // ── Parse + log every row so you can see the raw values ────────────────
  const parsed = rows.map(parseRow);
  console.log("All parsed rows (credit | daysLeft | ignore | deadline):");
  for (const r of parsed) {
    console.log(
      `  • ${r.credit} | daysLeft=${r.daysLeft} | ignore=${r.ignore} | deadline=${r.nextDeadline}`,
    );
  }

  // Warn if formulas came back null — signals a property-name or API mismatch.
  const nullDays = parsed.filter((r) => r.daysLeft === null);
  if (nullDays.length) {
    console.warn(
      `${nullDays.length} row(s) had daysLeft=null. Check that the "Days left" ` +
        `formula property name matches exactly and returns a number.`,
    );
  }

  // ── Filter ─────────────────────────────────────────────────────────────
  // Sort fewest → most days left, then decide on the trigger but email the window.
  const eligible = parsed
    .filter((r) => !r.ignore && r.daysLeft !== null && r.daysLeft >= 0)
    .sort((a, b) => a.daysLeft! - b.daysLeft!);

  const triggering = eligible.filter((r) => r.daysLeft! < TRIGGER_DAYS);
  console.log(
    `${triggering.length} row(s) under the ${TRIGGER_DAYS}-day trigger:`,
    triggering.map((r) => `${r.credit} (${r.daysLeft}d)`),
  );

  if (triggering.length === 0) {
    console.log(
      `Nothing under the ${TRIGGER_DAYS}-day trigger — no email sent.`,
    );
    return;
  }

  const expiring = eligible.filter((r) => r.daysLeft! < EMAIL_WINDOW);
  console.log(
    `Emailing ${expiring.length} credit(s) under ${EMAIL_WINDOW} days:`,
    expiring.map((r) => `${r.credit} (${r.daysLeft}d)`),
  );

  // ── Send ───────────────────────────────────────────────────────────────
  await email({
    subject: `💳 ${expiring.length} credit${
      expiring.length === 1 ? "" : "s"
    } expiring soon`,
    html: buildHtml(expiring),
  });
  console.log(`✅ Emailed about ${expiring.length} credit(s).`);
}

// ── Notion query (handles pagination) ──────────────────────────────────────
async function queryAllRows(): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  let pageNum = 0;
  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
      },
    );
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`Notion API error ${res.status}: ${bodyText}`);
    const data = JSON.parse(bodyText);
    console.log(
      `  Notion page ${++pageNum}: got ${data.results.length}, has_more=${data.has_more}`,
    );
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ── Extract the fields we care about from a Notion page ─────────────────────
function parseRow(page: any) {
  const p = page.properties ?? {};
  const nextDeadline = p["Next deadline"]?.formula;
  return {
    url: page.url,
    credit: (p["Credit"]?.title ?? []).map((t: any) => t.plain_text).join("") ||
      "(untitled)",
    daysLeft: p["Days left"]?.formula?.number ?? null,
    nextDeadline: nextDeadline?.type === "date"
      ? nextDeadline.date?.start
      : nextDeadline?.type === "string"
      ? nextDeadline.string
      : null,
    card: p["Card"]?.select?.name ?? "",
    category: p["Category"]?.select?.name ?? "",
    amount: p["Amount per period"]?.number ?? null,
    activation: p["Activation required"]?.checkbox ?? false,
    ignore: p["Ignore"]?.checkbox ?? false,
  };
}

// ── Build the email body ────────────────────────────────────────────────────
function buildHtml(items: ReturnType<typeof parseRow>[]) {
  const money = (
    n: number | null,
  ) => (n === null ? "" : `$${n.toLocaleString()}`);
  const rows = items
    .map((i) => {
      const urgent = i.daysLeft! <= 7;
      return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          <a href="${i.url}" style="color:#111;text-decoration:none;font-weight:600;">${i.credit}</a>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:${
        urgent ? "#c00" : "#111"
      };font-weight:${urgent ? 700 : 400};text-align:center;">
          ${i.daysLeft}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${
        i.nextDeadline ?? ""
      }</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${
        money(i.amount)
      }</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${i.card}</td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;">
    <h2 style="margin:0 0 4px;">Credits expiring soon</h2>
    <p style="color:#555;margin:0 0 16px;">These have fewer than ${EMAIL_WINDOW} days left. Use them or lose them.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="text-align:left;color:#666;font-size:12px;text-transform:uppercase;">
          <th style="padding:8px 12px;">Credit</th>
          <th style="padding:8px 12px;text-align:center;">Days left</th>
          <th style="padding:8px 12px;text-align:center;">Deadline</th>
          <th style="padding:8px 12px;text-align:right;">Amount</th>
          <th style="padding:8px 12px;">Card</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
