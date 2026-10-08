const fs = require("node:fs");
const path = require("node:path");
const CONFIG_FILE = path.join(__dirname, "../../user_config.json");
const DEFAULT_CONFIG = {
  defaultGroupName: "Rockdale Homies Grocery",
  defaultGroupId: "120363424816420097@g.us",
  groupStartDates: {
    "120363424816420097@g.us": "2026-04-20",
  },
  aliases: {
    224661300330706: "Arjun Bhurtel",
    "+224661300330706": "Arjun Bhurtel",
    "MR.Arjun.Bhurtel": "Arjun Bhurtel",
    193334178805180: "Arpan Bhurtel",
    "+193334178805180": "Arpan Bhurtel",
    "Arpan Bhurtel": "Arpan Bhurtel",
    111888394354735: "Shiva Kafle",
    "+111888394354735": "Shiva Kafle",
    "SHIVA ME": "Shiva Kafle",
    60821199667305: "Swasti Adhikari",
    "+60821199667305": "Swasti Adhikari",
    swasti: "Swasti Adhikari",
  },
};

function loadUserConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return {
        ...DEFAULT_CONFIG,
        ...data,
        aliases: data.aliases || { ...DEFAULT_CONFIG.aliases },
        groupStartDates: {
          ...DEFAULT_CONFIG.groupStartDates,
          ...(data.groupStartDates || {}),
        },
      };
    }
  } catch (err) {
    console.warn("[Config] Error reading user_config.json:", err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveUserConfig(patch) {
  try {
    const current = loadUserConfig();
    const updated = {
      ...current,
      ...patch,
      aliases: patch.aliases || current.aliases,
      groupStartDates: patch.groupStartDates || current.groupStartDates,
    };
    fs.writeFileSync(
      CONFIG_FILE + ".tmp",
      JSON.stringify(updated, null, 2),
      "utf8",
    );
    fs.renameSync(CONFIG_FILE + ".tmp", CONFIG_FILE);
    return updated;
  } catch (err) {
    console.error("[Config] Error saving user_config.json:", err.message);
    return null;
  }
}

module.exports = { loadUserConfig, saveUserConfig };
