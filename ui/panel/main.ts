import { connectHost } from "@openchamber/sdk";
import { createPanel } from "./app.ts";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing #root");
createPanel(connectHost(), root);
