"use strict";

function readPassword() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    process.stdout.write("Password (read from stdin): ");
    return new Promise((resolve, reject) => {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => resolve(input.trimEnd()));
      process.stdin.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stdout.write("Password (input hidden): ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const onData = (chunk) => {
      const char = chunk.toString("utf8");
      if (char === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        reject(new Error("Password input cancelled."));
      } else if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(value);
      } else if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
      } else if (char >= " ") {
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

module.exports = { readPassword };
