import { defineConfig } from "vite";

const multiplayerProxy = {
  target: "http://127.0.0.1:3001",
  ws: true
};

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/multiplayer": multiplayerProxy
    }
  },

  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    proxy: {
      "/multiplayer": multiplayerProxy
    }
  }
});