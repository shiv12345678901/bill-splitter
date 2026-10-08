(() => {
  const media = matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try {
    preference = localStorage.getItem("splitmate-appearance") || "system";
  } catch {}
  window.setAppearance = (value) => {
    preference = ["light", "dark", "system"].includes(value) ? value : "system";
    document.documentElement.dataset.appearance =
      preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document
      .querySelectorAll("[data-theme]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.theme === preference),
        ),
      );
    try {
      localStorage.setItem("splitmate-appearance", preference);
    } catch {}
  };
  media.addEventListener("change", () => window.setAppearance(preference));
  window.setAppearance(preference);
  document.addEventListener("DOMContentLoaded", () => {
    document
      .querySelectorAll("[data-theme]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          window.setAppearance(button.dataset.theme),
        ),
      );
    window.setAppearance(preference);
  });
})();
