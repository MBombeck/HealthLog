// Moves the wall clock of one Node process to PROBE_NOW (an ISO instant).
// Loaded through `NODE_OPTIONS=--import` by `scripts/test-shifted-clock.mjs`,
// so every Vitest worker it forks starts with the clock already moved.
//
// What follows the moved clock: `Date.now()`, `new Date()` without
// arguments, `Date()` called as a function, `Intl.DateTimeFormat#format()`
// and `#formatToParts()` without a date, and file timestamps (`stat` reads
// them forward by the offset, `utimes` writes them back by it, so a file
// written "now" reads as written at the moved now).
//
// What stays as it was, on purpose: a Date born anywhere else still passes
// `instanceof Date` (a structured clone from a worker thread, a native
// addon), `d.constructor === Date` still holds, and `vi.spyOn(Date, "now")`
// and `vi.useFakeTimers()` still win over the moved clock inside a test.
// The first two are why this is a Proxy and not a subclass: a subclass made
// every clone from the FIT decoder's worker fail `instanceof Date`.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const target = Date.parse(process.env.PROBE_NOW ?? "");
if (!Number.isNaN(target)) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const offset = target - realNow();
  const shiftedNow = () => realNow() + offset;
  // An own property rather than a Proxy trap, so a spy on `Date.now` wins.
  RealDate.now = shiftedNow;
  const ShiftedDate = new Proxy(RealDate, {
    construct(date, args, newTarget) {
      return Reflect.construct(
        date,
        args.length === 0 ? [shiftedNow()] : args,
        newTarget === ShiftedDate ? date : newTarget,
      );
    },
    apply() {
      return new RealDate(shiftedNow()).toString();
    },
  });
  RealDate.prototype.constructor = ShiftedDate;
  globalThis.Date = ShiftedDate;

  const dtf = Intl.DateTimeFormat.prototype;
  const format = Object.getOwnPropertyDescriptor(dtf, "format");
  Object.defineProperty(dtf, "format", {
    configurable: true,
    get() {
      const bound = format.get.call(this);
      return (date) => bound(date === undefined ? shiftedNow() : date);
    },
  });
  const formatToParts = dtf.formatToParts;
  dtf.formatToParts = function (date) {
    return formatToParts.call(this, date === undefined ? shiftedNow() : date);
  };

  const forward = (stats) => {
    if (!stats || typeof stats.mtimeMs !== "number") return stats;
    for (const field of ["atime", "mtime", "ctime", "birthtime"]) {
      stats[`${field}Ms`] += offset;
      stats[field] = new RealDate(stats[`${field}Ms`]);
    }
    return stats;
  };
  const back = (time) =>
    time instanceof RealDate
      ? new RealDate(time.getTime() - offset)
      : typeof time === "number" || typeof time === "string"
        ? Number(time) - offset / 1000
        : time;
  for (const name of ["statSync", "lstatSync", "fstatSync"]) {
    const real = fs[name];
    fs[name] = (...args) => forward(real(...args));
  }
  for (const name of ["stat", "lstat", "fstat"]) {
    const real = fs[name];
    fs[name] = (...args) => {
      const callback = args.pop();
      return real(...args, (error, stats) => callback(error, forward(stats)));
    };
  }
  for (const name of ["stat", "lstat"]) {
    const real = fs.promises[name];
    fs.promises[name] = async (...args) => forward(await real(...args));
  }
  for (const name of ["utimesSync", "lutimesSync", "futimesSync"]) {
    const real = fs[name];
    fs[name] = (path, atime, mtime) => real(path, back(atime), back(mtime));
  }
  for (const name of ["utimes", "lutimes", "futimes"]) {
    const real = fs[name];
    fs[name] = (path, atime, mtime, callback) =>
      real(path, back(atime), back(mtime), callback);
  }
  for (const name of ["utimes", "lutimes"]) {
    const real = fs.promises[name];
    fs.promises[name] = (path, atime, mtime) =>
      real(path, back(atime), back(mtime));
  }
  syncBuiltinESMExports();
}
