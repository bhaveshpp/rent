# Rent Manager — property & tenant management (Google Sheet + Apps Script + GitHub Pages)

```
backend/Code.gs   → Apps Script (paste in the Sheet's script editor)
site/             → index.html (login, same for everyone) · home.html · property.html · tenant.html
                    analysis.html · manage.html · common.js · store.js · forms.js · common.css
```

## Setup
1. New Google Sheet → **Extensions → Apps Script** → paste `backend/Code.gs`.
2. Run **`setupSheets`** → tabs: Admin, Properties, Tenants, Rules, Transactions.
3. In `createAdmin` set `ADMIN_MOBILE / NAME / PASSWORD` (`ADMIN_ROLE = 'Owner'`) → run it → your login exists.
   A **read-only admin**: change the constants (another mobile, `ADMIN_ROLE = 'Viewer'`) and run it again, or add an Admin row by hand with `Role = Viewer`.
4. **Deploy → New deployment → Web app** → Execute as *Me*, Access *Anyone* → copy the URL.
5. Paste the URL in `site/common.js` → `API_URL`; upload all `site/` files to GitHub Pages.
After any Code.gs change: Deploy → Manage deployments → pencil → *New version* → Deploy.

## Tabs
| Tab | Columns |
|---|---|
| Admin | Mobile, Name, Password (hashed), Role (Owner / Viewer), Status |
| Properties | Property_ID, Name, Address, Status, Note |
| Tenants | Tenant_ID, Name, Mobile, Password (hashed), Property_ID, Unit, Monthly_Rent, Due_Day, Deposit, Lease_Start, Lease_End, Status, Note |
| Rules | Rule_ID, Property_ID (or ALL), Rule_Text |
| Transactions | Txn_ID, Date, Type, Property_ID, Tenant_ID, Rent_Month, Rent_Due, Amount, Notes |

Types: `Rent` · `Expense` · `Payout` · `Deposit Received` · `Deposit Refund`.
You may add your own extra columns (ID proof, Drive link …) to any tab — the app never reads, shows or saves them.
Rows typed by hand without an ID → run **`fillMissingIds`**. Keep Date / Rent_Month / Lease_* columns as plain text `yyyy-MM-dd` / `yyyy-MM` (setupSheets formats them).

## How it works
- **Login:** one page, mobile + password. Script looks in Admin first, then Tenants. A mobile can exist only once across both. 5 wrong passwords = 15 min lock.
- **Roles:** Owner = everything · Viewer = sees everything, every write is refused by the script · Tenant = only own tenancy.
- **Rent status** (computed from Transactions): a month's rent = `Rent_Due` of that month's entries (so old months keep the old rent), else the tenant's current Monthly_Rent. Several Rent entries in one month add up (partial payments). Paid · Partial · Due · Overdue · Upcoming. Rent increase = just change Monthly_Rent on the tenant.
- **Deposit:** `Deposit` column = agreed total; `Deposit Received / Refund` entries = what actually moved. Held = received − refunded. **Close tenancy** (tenant page) = Inactive + Lease_End + optional refund entry.
- **Money view:** Left in hand = Rent − Expense − Payout (deposits are shown separately). Expense / Payout belong to a property, never to a tenant.
- **Caching:** the whole dataset is fetched once and cached on the device for 5 minutes; year / filter / page changes never call the API. ⟳ in the header (or profile menu) forces a fresh load. Rent / Expense / Payout / Deposit entries appear instantly and sync in the background (⚠ Not saved + Retry on error; offline entries stay queued). Property / tenant / rule edits wait for the server. Logout clears the cache.
- **Tenant isolation:** the script sends a tenant only their own tenant row, property, rules (ALL + own property) and their own Rent/Deposit entries. Private owner notes on the tenant/property are never sent. **Notes on a tenant's Rent / Deposit entries ARE visible to that tenant** — keep private remarks in Expense/Payout notes or the tenant Note.
