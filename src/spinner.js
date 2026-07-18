// Drop-in replacement for ora's start/succeed/fail/warn API, minus the
// animation and the "start" line. These calls wrap synchronous steps that
// finish essentially instantly (git checkout, mkdir, ...) — printing a
// "please wait" line right before the result that appears in the same
// instant is just noise. Only the outcome (✔/✖/⚠) is worth showing.
// For steps that can genuinely run for a long time with nothing to report
// in between, use printWaiting() instead.
import pc from "picocolors";

export function createSpinner(text) {
  let current = text;
  return {
    start() {
      return this;
    },
    succeed(text) {
      current = text ?? current;
      console.log(pc.green(`✔ ${current}`));
      return this;
    },
    fail(text) {
      current = text ?? current;
      console.log(pc.red(`✖ ${current}`));
      return this;
    },
    warn(text) {
      current = text ?? current;
      console.log(pc.yellow(`⚠ ${current}`));
      return this;
    },
  };
}

// Static "please wait" line for a synchronous call that can run for a long
// time with no progress to report (e.g. invoking the claude CLI). An
// animated spinner around a call like that just freezes mid-frame for the
// whole duration and reads as a hang — this says up front there's nothing
// to show instead.
export function printWaiting(text) {
  console.log(pc.yellow(`⏳ ${text}`));
}
