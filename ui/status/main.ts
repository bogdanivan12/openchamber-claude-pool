import { connectHost } from "@openchamber/sdk";
import { createStatus } from "./app.ts";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing #root");
createStatus(connectHost(), root);
