export const $ = (selector) => document.querySelector(selector);
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const iconPaths = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5M9 21v-6h6v6"/>',
  history: '<path d="M4 6.5A9 9 0 1 1 3 12"/><path d="M4 3v3.5h3.5M12 7v5l3 2"/>',
  settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1 1.6 1.3-1.8 3.1-2-.8a8 8 0 0 1-2 1.2l-.3 2.1h-3.6l-.3-2.1a8 8 0 0 1-2-1.2l-2 .8-1.8-3.1L7 15.1a8 8 0 0 1 0-2.2l-1.7-1.4L7 8.4l2 .8a8 8 0 0 1 2-1.2l.3-2.1h3.6l.3 2.1a8 8 0 0 1 2 1.2l2-.8 1.8 3.1-1.6 1.4a8 8 0 0 1 0 2.1Z"/>',
  receipt: '<path d="M6 3h12v18l-3-1.7L12 21l-3-1.7L6 21V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.8-4L3 10"/><path d="M3 5v5h5M4 13a8 8 0 0 0 14.8 4L21 14"/><path d="M21 19v-5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUpRight: '<path d="M7 17 17 7M8 7h9v9"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevronLeft: '<path d="m14 6-6 6 6 6"/>',
  chevronRight: '<path d="m10 6 6 6-6 6"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M17 4.2a3.5 3.5 0 0 1 0 6.6"/><path d="M21 21v-2a4 4 0 0 0-2.5-3.7"/>',
  send: '<path d="m21.5 2.5-7 19-4-9-9-4Z"/><path d="M21.5 2.5 10.5 12.5"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22v-7"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.6A8.5 8.5 0 1 1 21 11.5Z"/>',
  key: '<circle cx="8" cy="16" r="4"/><path d="m11 13 9.5-9.5"/><path d="m16.5 7.5 3 3"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
};
export const icon = (name, label = "") =>
  `<svg class="icon" aria-hidden="${label ? "false" : "true"}"${label ? ` role="img" aria-label="${esc(label)}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || ""}</svg>`;
export const button = (label, action, cls = "", attrs = "") =>
  `<button class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
export const date = (value) => {
  const d = new Date(String(value).slice(0, 10) + "T12:00:00");
  return Number.isNaN(+d)
    ? "No date"
    : d.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
};
export const empty = (title, description, action = "") =>
  `<div class="empty"><span class="empty-symbol" aria-hidden="true">${icon("receipt")}</span><h2>${title}</h2><p>${description}</p>${action}</div>`;
let toastTimer;
export function toast(message, undo) {
  clearTimeout(toastTimer);
  $("#toast").innerHTML =
    `<span>${esc(message)}</span>${undo ? '<button id="undo">Undo</button>' : ""}`;
  $("#toast").hidden = false;
  if (undo)
    $("#undo").onclick = () => {
      undo();
      $("#toast").hidden = true;
    };
  toastTimer = setTimeout(
    () => {
      $("#toast").hidden = true;
    },
    undo ? 12000 : 5000,
  );
}
export function dialog(title, body, onSubmit) {
  const root = $("#dialog");
  root.innerHTML = `<form id="dialog-form"><header><h2 id="dialog-title">${esc(title)}</h2><button type="button" class="icon-button" aria-label="Close dialog" id="close-dialog">${icon("close")}</button></header>${body}</form>`;
  root.showModal();
  root.onclose = () => {
    if (!root.open) root.innerHTML = "";
  };
  $("#close-dialog").onclick = () => root.close();
  $("#dialog-form").onsubmit = async (e) => {
    e.preventDefault();
    await onSubmit?.(new FormData(e.target), root);
  };
  root.onclick = (e) => {
    if (e.target === root) {
      const r = root.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        root.close();
    }
  };
}
export const field = (label, name, value = "", type = "text", attrs = "") =>
  `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
let lightboxKeyNav = null;
// Full-screen receipt preview with next/previous navigation across a list.
export function openLightbox(items, startIndex) {
  const root = $("#lightbox");
  if (!root || !items.length) return;
  let index = Math.min(Math.max(startIndex, 0), items.length - 1);
  const source = (e) => {
    const t = e.thumbnail || e.photo || "";
    return /^data:image\/(png|jpeg|webp);base64,/.test(t) ||
      t.startsWith("/api/media?")
      ? t
      : "";
  };
  const close = () => {
    root.hidden = true;
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  const render = () => {
    const e = items[index];
    const url = source(e);
    root.innerHTML = `<div class="lightbox-inner"><header><div><b>${esc(e.merchant)}</b><span>${esc(e.paidBy || "Unknown payer")} · ${date(e.date)}</span></div><button class="icon-button" id="lightbox-close" aria-label="Close preview">${icon("close")}</button></header>${
      url
        ? `<img src="${esc(url)}" alt="Receipt from ${esc(e.merchant)}">`
        : '<div class="lightbox-empty">No image available for this receipt</div>'
    }<footer><button class="icon-button" id="lightbox-prev" aria-label="Previous receipt"${index === 0 ? " disabled" : ""}>${icon("chevronLeft")}</button><span>${index + 1} of ${items.length}</span><button class="icon-button" id="lightbox-next" aria-label="Next receipt"${index === items.length - 1 ? " disabled" : ""}>${icon("chevronRight")}</button></footer></div>`;
    root.hidden = false;
    $("#lightbox-close").onclick = close;
    const prev = $("#lightbox-prev");
    const next = $("#lightbox-next");
    prev.onclick = () => {
      if (index > 0) {
        index--;
        render();
      }
    };
    next.onclick = () => {
      if (index < items.length - 1) {
        index++;
        render();
      }
    };
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && index > 0) {
      index--;
      render();
    } else if (e.key === "ArrowRight" && index < items.length - 1) {
      index++;
      render();
    }
  };
  if (lightboxKeyNav) document.removeEventListener("keydown", lightboxKeyNav);
  lightboxKeyNav = onKey;
  document.addEventListener("keydown", onKey);
  render();
}
export function download(name, value, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Summary copied. Payment status is unchanged.");
  } catch {
    dialog(
      "Copy payment summary",
      `<label>Select and copy this summary<textarea readonly rows="12">${esc(text)}</textarea></label>`,
    );
  }
}
