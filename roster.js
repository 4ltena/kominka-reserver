/**
 * 名簿の操作。画面からは編集できないため、必要なときは Pi 上でこれを使う。
 *
 *     node roster.js list
 *     node roster.js add そら
 *     node roster.js hide そら
 *     node roster.js show そら
 */

import { DEFAULT_DB_PATH } from "./src/config.js";
import * as db from "./src/db.js";

const USAGE = [
  "node roster.js list",
  "node roster.js add <名前>",
  "node roster.js hide <名前>",
  "node roster.js show <名前>",
].join("\n");

export function main(argv) {
  const command = argv[0];
  if (!["list", "add", "hide", "show"].includes(command)) {
    console.log(USAGE);
    return 1;
  }

  const database = db.connect(process.env.DB_PATH ?? DEFAULT_DB_PATH);
  db.initSchema(database);

  try {
    if (command === "list") {
      for (const member of db.listMembers(database, true)) {
        const mark = member.active ? "" : "  (非表示)";
        console.log(`${String(member.id).padStart(3)}  ${member.name}${mark}`);
      }
      return 0;
    }

    const name = argv[1];
    if (!name) {
      console.log("名前が要る");
      return 1;
    }

    if (command === "add") {
      try {
        console.log(`追加した: ${db.addMember(database, name)}  ${name}`);
      } catch (error) {
        if (!(error instanceof db.InvalidName)) throw error;
        console.log(error.message);
        return 1;
      }
      return 0;
    }

    const target = db.listMembers(database, true).find((member) => member.name === name);
    if (target === undefined) {
      console.log(`見つからない: ${name}`);
      return 1;
    }
    db.setMemberActive(database, target.id, command === "show");
    console.log(`${command === "show" ? "表示" : "非表示"}にした: ${name}`);
    return 0;
  } finally {
    database.close();
  }
}

process.exitCode = main(process.argv.slice(2));
