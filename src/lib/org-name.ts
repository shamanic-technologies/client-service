/**
 * The display name of an org opened from nothing but an email (AI agent signup).
 *
 * Owner rule 2026-10-18: the email's DOMAIN, except a free-mail domain ("gmail &
 * co"), where the domain names a mailbox provider shared by millions, not the
 * client. There the org carries the PERSON's name, read off the address itself
 * (`jane.doe@gmail.com` → "Jane Doe"): the only name this path knows. Never
 * "gmail.com", never a generic label. Last fallback, when the local part holds
 * no letters (`12345@gmail.com`): the local part as typed, still theirs.
 * The person renames it on the dashboard.
 */
export function orgNameForEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (!FREE_MAIL_DOMAINS.has(domain)) return domain;
  return personNameFromLocalPart(local);
}

/** `jane.doe+news` → "Jane Doe"; `j_smith42` → "J Smith"; `12345` → "12345". */
function personNameFromLocalPart(local: string): string {
  const base = local.split("+")[0] || local;
  const words = base
    .split(/[._\-\s]+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ""))
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase());
  return words.length > 0 ? words.join(" ") : base;
}

/** Consumer mailbox providers: a domain here says nothing about who the client is. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "hotmail.com",
  "hotmail.fr",
  "hotmail.co.uk",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.fr",
  "gmx.net",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "qq.com",
  "163.com",
  "naver.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
]);
