import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "Forms Autofill",
    description: "Fills Google Forms with AI, page by page, and never submits without your confirmation.",
    permissions: ["activeTab", "storage", "scripting", "sidePanel"],
    host_permissions: ["https://docs.google.com/forms/*"],
    // Requested at runtime by the options page for the chosen endpoint only.
    optional_host_permissions: [
      "https://api.anthropic.com/*",
      "https://api.openai.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ],
  },
});
