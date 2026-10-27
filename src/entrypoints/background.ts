import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { handleMessage, onTabRemoved } from "../background/router";

export default defineBackground({
  type: "module",
  main() {
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      void handleMessage(msg, sender).then(sendResponse);
      return true; // async reply
    });
    browser.tabs.onRemoved.addListener((tabId) => void onTabRemoved(tabId));
  },
});
