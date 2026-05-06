const fs = require('fs');
let code = fs.readFileSync('main.js', 'utf8');

// 1. Add crypto
if (!code.includes('const crypto = require("crypto");')) {
    code = code.replace('const path = require("path");', 'const path = require("path");\nconst crypto = require("crypto");\nconst hashC = (str) => crypto.createHash("md5").update(str).digest("hex").substring(0, 16);\nconst findC = (h, list) => list.find(x => hashC(x) === h);');
}

// 2. Replace encoding
code = code.replace(/Buffer\.from\((c|cName)\)\.toString\('base64'\)/g, 'hashC($1)');
code = code.replace(/Buffer\.from\(p\.category\)\.toString\('base64'\)/g, 'hashC(p.category)');

// 3. Replace decoding
code = code.replace(/Buffer\.from\(ctx\.match\[1\], 'base64'\)\.toString\('ascii'\)/g, 'findC(ctx.match[1], readDB(db_path.store).categories)');
code = code.replace(/Buffer\.from\(catStrBase64, 'base64'\)\.toString\('utf-8'\)/g, 'findC(catStrBase64, readDB(db_path.store).categories)');

// 4. Rate Spamming Fix
code = code.replace('await ctx.editMessageText("✅ Penilaian Berhasil, terimaksih telah meluangkan waktunya untuk memberikan penilaian 🥰.");', 'await ctx.editMessageText("✅ Penilaian Berhasil, terimakasih telah meluangkan waktunya untuk memberikan penilaian 🥰.").catch(()=>{});\n        await ctx.answerCbQuery("Terimakasih atas penilaiannya!", false).catch(()=>{});');

// 5. DeleteMessage exceptions (orphan handled in later replacement)
code = code.replace(/await ctx\.deleteMessage\(\);/g, 'await ctx.deleteMessage().catch(()=>{});');
code = code.replace(/return ctx\.deleteMessage\(\);/g, 'return ctx.deleteMessage().catch(()=>{});');

// 6. Orphan Flash Sale Items Handling
code = code.replace(/store\.products\.splice\(pIdx, 1\);\r?\n\s*writeDB\(db_path\.store, store\);/g, `store.products.splice(pIdx, 1);
        writeDB(db_path.store, store);
        let fsList = readDB(db_path.flashsale) || [];
        const initialLen = fsList.length;
        fsList = fsList.filter(f => String(f.productId) !== String(pId));
        if (fsList.length < initialLen) writeDB(db_path.flashsale, fsList);`);

fs.writeFileSync('main.js', code);
console.log('Fix applied!');
