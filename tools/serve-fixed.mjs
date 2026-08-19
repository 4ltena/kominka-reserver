/** 時刻を固定した Express を立てる。差分比較のためだけに使う。 */

import { createApp } from "../src/app.js";
import { clock } from "../src/clock.js";

const now = Number(process.argv[2]);
clock.now = () => now;
createApp({ dbPath: process.argv[3] }).listen(Number(process.argv[4]), "127.0.0.1");
