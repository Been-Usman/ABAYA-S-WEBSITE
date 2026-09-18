# Storage setup — what is broken and how to fix it

This file records the **live-verified** findings from the audit of the image
upload pipeline, and the exact dashboard/SQL steps needed to finish it.
The application code itself is already fixed (see the bottom of this file).

Project: `https://yntkbjzvmizssrxwzuoi.supabase.co`
Key in use: `sb_publishable_...kx5vLA_u` (publishable / anon)

---

## 1. Supabase — the storage bucket does not exist

**Evidence (live request, not a guess):**

```
POST https://yntkbjzvmizssrxwzuoi.supabase.co/storage/v1/object/PRODUCT-IMAGES/t.jpg
→ HTTP 400
{"statusCode":"404","error":"Bucket not found","message":"Bucket not found","code":"NoSuchBucket"}
```

The same answer comes back for `product-images`, `Product-Images`,
`product_images`, `PRODUCTIMAGES`, `nakowa-images`, `nakowa-product-images`,
`images` and 12 more probed names — on both the upload route and the public
read route.

**Why this proves the bucket is missing (and not an RLS problem):**
Supabase Storage resolves the bucket during upload with

```ts
// supabase/storage  src/storage/object.ts
const bucket = await this.db
  .asSuperUser()                                   // ← RLS is bypassed here
  .findBucketById(this.bucketId, 'id, file_size_limit, allowed_mime_types')
```

so an RLS problem would return `403 … row-level security policy`, never
`404 NoSuchBucket`. A **missing** bucket is the only explanation. (The
publishable key itself is fine: a wrong key is rejected with
`403 Invalid Compact JWS`, which we did not get.)

**Fix — Supabase Dashboard**
1. Open the project → **Storage** → **New bucket**.
2. Name: `product-images` (the dashboard lowercases names) — the code also
   accepts `PRODUCT-IMAGES`, so either casing works.
3. Enable **Public bucket** (the site builds public URLs).
4. Save.

**Fix — SQL editor (equivalent, and adds the required policies)**

```sql
-- 1. the bucket
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

-- 2. let the anon key UPLOAD images into this bucket
create policy "nakowa anon upload"
on storage.objects for insert to anon
with check (bucket_id = 'product-images');

-- 3. let the anon key READ the objects (needed by the list/count helper)
create policy "nakowa anon read"
on storage.objects for select to anon
using (bucket_id = 'product-images');
```

> The `anon` role is what a `sb_publishable_…` key acts as. Without policy #2
> uploads fail with `403 new row violates row-level security policy`; without
> #3 the image-count helper simply returns 0.

---

## 2. Cloudinary — the cloud name / preset is also not resolving

Videos (and every image once the Supabase threshold is reached) go to
Cloudinary. That endpoint is currently broken too:

```
POST https://api.cloudinary.com/v1_1/Idtixrva/image/upload   (upload_preset=NAKOWA-ABAYAS)
→ HTTP 401  {"error":{"message":"Unknown API key "}}

POST https://api.cloudinary.com/v1_1/demo/image/upload       (sanity check, real cloud)
→ HTTP 400  {"error":{"message":"Upload preset must be whitelisted for unsigned uploads"}}
```

A real cloud answers with a *preset* complaint; `Idtixrva` answers exactly
like a cloud name that does not exist, so Cloudinary cannot resolve the
account (and therefore cannot resolve the preset either).

**Fix — Cloudinary Dashboard**
1. Copy the **Cloud name** shown at the top of the console and write it into
   `CLOUDINARY.cloudName` (and the two `…/v1_1/<cloud>/…` URLs) in
   `admin/admin.js`.
2. **Settings → Upload → Upload presets → Add upload preset**
   - Name: `NAKOWA-ABAYAS`
   - **Signing Mode: Unsigned** ← required for browser uploads
   - Folder: `ABAYAS-VIDEO-IMGS`

---

## 3. Verify from the command line

```powershell
$k = 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u'

# bucket exists?
curl.exe -s -H "apikey: $k" -H "Authorization: Bearer $k" `
  "https://yntkbjzvmizssrxwzuoi.supabase.co/storage/v1/bucket/product-images"

# upload works?  (expect {"Key":"..."} instead of NoSuchBucket)
curl.exe -s -X POST -H "apikey: $k" -H "Authorization: Bearer $k" `
  -H "Content-Type: image/jpeg" --data-binary "@photo.jpg" `
  "https://yntkbjzvmizssrxwzuoi.supabase.co/storage/v1/object/product-images/test.jpg"
```

Then open the admin panel → Products → Add Products → select images → save and
watch the console: every file must print `[Supabase] ✅ Upload SUCCESS: …`
with **no red errors**.

---

## 4. What the code now does on its own

* `resolveSupabaseBucket()` probes the candidate bucket ids **once per
  session** (case-insensitively) and remembers the one that really exists, so
  the code follows whatever casing the dashboard shows.
* While no bucket exists, the Supabase request pipeline is **skipped
  entirely** — no guaranteed-to-fail request per image, and a single
  `console.warn` explains what to create.
* Every failure is reported through `logOnce()` / `warnOnce()`: one readable
  line per unique reason instead of one per file.
* Broken images fall back to a local `data:image/svg+xml` URI exactly once
  (`window.imgFallback`), so image errors can no longer loop.