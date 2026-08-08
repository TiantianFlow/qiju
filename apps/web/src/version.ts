// THE-29: build-time version string, format YYYY-MM-DD.N.
// YYYY-MM-DD is the UTC calendar date of the newest commit (the one being
// built); N is the 1-based count of commits on that same UTC date in the
// commit's ancestry (so the first commit of a day is .1, the second .2).
// The pure function is kept separate from the git invocation in
// vite.config.ts so it can be unit-tested without a repository.

const utcDay = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export function computeVersionString(commitTimestamps: number[]): string {
  const head = commitTimestamps[0];
  if (head === undefined) return "dev";
  const day = utcDay(head);
  const sameDayCount = commitTimestamps.filter((ts) => utcDay(ts) === day).length;
  return `${day}.${sameDayCount}`;
}
