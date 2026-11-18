import { state, change, persist } from "./store.mjs";
import { today, normaliseReceipt } from "./domain.mjs";
import { dialog, field, esc, toast, $ } from "./ui.mjs";
import { beginScan, request } from "./connection.mjs";
const footer = (label) =>
  `<footer><button class="primary" type="submit">${label}</button></footer>`;
export function editPeriod() {
  if (state.archive || state.work.closedAt || state.scan)
    return toast("Finish the current scan before changing settlement details.");
  dialog(
    "Settlement details",
    `${field("Household name", "groupName", state.work.groupName, "text", 'required maxlength="100"')}<div class="form-row">${field("From", "startDate", state.work.startDate, "date", "required")}${field("To", "endDate", state.work.endDate, "date", "required")}</div><label>People sharing these expenses<textarea name="members" required rows="5" placeholder="One name per line">${esc(state.work.members.join("\n"))}</textarea></label><p class="muted">Include everyone sharing the costs, even if they have not paid for a receipt. Changing details resets payment confirmations.</p>${footer("Save details")}`,
    (form, root) => {
      const data = Object.fromEntries(form),
        members = [
          ...new Set(
            data.members
              .split("\n")
              .map((n) => n.trim())
              .filter(Boolean),
          ),
        ];
      if (data.startDate > data.endDate)
        return toast("The end date must be on or after the start date.");
      if (!members.length) return toast("Add at least one person.");
      change((w) => Object.assign(w, data, { members }));
      root.close();
    },
  );
}
export function addReceipt() {
  if (state.archive || state.work.closedAt) return;
  dialog(
    "Add an expense",
    `${field("Merchant or description", "merchant", "", "text", 'required maxlength="120"')}<div class="form-row">${field("Amount · AUD", "amount", "", "number", 'required min="0.01" max="999999" step="0.01"')}${field("Date", "date", today(), "date", "required")}</div>${field("Paid by", "paidBy", state.work.members[0] || "", "text", 'required list="people" maxlength="100"')}<datalist id="people">${state.work.members.map((n) => `<option value="${esc(n)}">`).join("")}</datalist><label>Category<select name="category"><option>Groceries</option><option>Utilities</option><option>Dining</option><option>Household Supplies</option><option>Other</option></select></label>${footer("Add expense")}`,
    (form, root) => {
      const e = normaliseReceipt({
        ...Object.fromEntries(form),
        reviewed: true,
      });
      e.merchant = e.merchant.trim();
      e.paidBy = e.paidBy.trim();
      if (!e.merchant || !e.paidBy || e.amount <= 0)
        return toast("Enter a merchant, payer and positive amount.");
      change((w) => {
        w.expenses.push(e);
        if (!w.members.includes(e.paidBy)) w.members.push(e.paidBy);
      });
      state.selected = e.id;
      root.close();
      location.hash = "receipts";
    },
  );
}
export function collect() {
  if (state.archive || state.work.closedAt) return;
  if (state.scan)
    return toast("Finish or discard the current scan before starting another.");
  const ready = state.online && state.status === "READY" && state.keys;
  const groups = state.groups.length
    ? state.groups
    : [{ id: state.work.groupId, name: state.work.groupName }];
  dialog(
    "Collect receipts",
    `<p class="muted">Choose a WhatsApp group and date range. Your current receipts stay safe until the scan finishes. To scan a past settlement cycle, use the Cycles page.</p>${!ready ? '<p class="inline-warning">Connect WhatsApp and configure receipt recognition in Settings first. You can still add expenses manually.</p>' : ""}<label>WhatsApp group<select name="groupId" required>${groups
      .filter((g) => g.id)
      .map(
        (g) =>
          `<option value="${esc(g.id)}" ${g.id === state.work.groupId ? "selected" : ""}>${esc(g.name)}</option>`,
      )
      .join(
        "",
      )}</select></label><div class="form-row">${field("From", "startDate", state.work.startDate, "date", "required")}${field("To", "endDate", state.work.endDate, "date", "required")}</div><details><summary>Scan options</summary>${field("Maximum messages to check", "maxMessages", 600, "number", 'min="50" max="10000" step="50"')}<label class="check"><input name="useCheckpoint" type="checkbox" checked> Start after the last "clear up to date" message</label><p class="muted">When ticked, the scan searches this chat for the newest settlement marker and only reads receipts sent after it — the dates above become fallback limits. Untick to read the whole date range instead.</p></details><footer><button type="button" class="secondary" data-action="add">Add manually</button><button type="submit" class="primary" ${!ready ? "disabled" : ""}>Start scan</button></footer>`,
    (form, root) => {
      const d = Object.fromEntries(form);
      if (d.startDate > d.endDate)
        return toast("Choose a valid date range.");
      const context = {
        groupId: d.groupId,
        groupName:
          groups.find((g) => g.id === d.groupId)?.name || state.work.groupName,
        startDate: d.startDate,
        endDate: d.endDate,
      };
      if (
        beginScan(context, {
          maxMessages: Number(d.maxMessages),
          useCheckpoint: form.has("useCheckpoint"),
        })
      )
        root.close();
    },
  );
}
export function connect() {
  dialog(
    "WhatsApp connection",
    `<div id="connection-detail"></div><p class="muted">On your phone, open WhatsApp, then choose Linked devices and Link a device.</p><footer>${state.status === "READY" ? '<button type="button" class="secondary danger" data-action="logout">Disconnect</button>' : '<button type="submit" class="primary">Reconnect</button>'}</footer>`,
    () => {
      request("whatsapp:reconnect");
      toast("Starting WhatsApp. The pairing code will appear here.");
    },
  );
  updateConnection();
}
export function updateConnection() {
  if (!$("#connection-detail")) return;
  $("#connection-detail").innerHTML =
    state.qr && /^data:image\//.test(state.qr)
      ? `<img class="qr" src="${esc(state.qr)}" alt="WhatsApp device pairing QR code">`
      : `<p class="connection-state">${state.status === "READY" ? "WhatsApp is connected" : state.status === "DISCONNECTED" ? "Not connected. Reconnect to generate a pairing code." : "Connecting to WhatsApp…"}</p>`;
}
export function keys() {
  dialog(
    "Receipt recognition",
    '<p class="muted">Paste one key per line, or use numbered <code>GEMINI_API_KEY_1=value</code> lines. Keys are kept in server memory until restart and are never included in workspace backups.</p><label>Gemini API keys<textarea id="gemini-api-keys" name="keys" rows="8" required autocomplete="off" spellcheck="false" placeholder="GEMINI_API_KEY_1=your-key&#10;GEMINI_API_KEY_2=your-key"></textarea></label><label>Import an .env or text file<input id="gemini-key-file" type="file" accept=".env,.txt,text/plain"></label><p class="muted">Imported values remain visible here so you can check them before saving.</p>' +
      footer("Save keys"),
    (form, root) => {
      const value = form.get("keys").trim();
      if (!value) return toast("Add at least one Gemini API key.");
      if (request("config:set_gemini_keys", { keys: value }))
        root.close();
    },
  );
  const fileInput = $("#gemini-key-file");
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 65536) {
      fileInput.value = "";
      return toast("Choose an .env or text file smaller than 64 KB.");
    }
    try {
      $("#gemini-api-keys").value = await file.text();
    } catch {
      toast("That file could not be read. Paste the keys instead.");
    }
  });
}
export function aliases() {
  const entries = Object.entries(state.aliases);
  dialog(
    "Names from WhatsApp",
    `<p class="muted">Each line maps a sender identifier to a household name: identifier = name</p><label>Name mappings<textarea name="aliases" rows="10">${esc(entries.map(([k, v]) => `${k} = ${v}`).join("\n"))}</textarea></label>${footer("Save names")}`,
    (form, root) => {
      const map = {};
      for (const line of form
        .get("aliases")
        .split("\n")
        .filter((l) => l.trim())) {
        const idx = line.indexOf("=");
        if (idx < 1 || !line.slice(idx + 1).trim())
          return toast("Use identifier = name on every line.");
        map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (
        request("config:save_aliases", {
          groupId: state.work.groupId,
          aliases: map,
        })
      ) {
        state.aliases = map;
        persist();
        root.close();
        toast("Names saved.");
      }
    },
  );
}
