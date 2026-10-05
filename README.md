# AURORA Mini App — Backend + Database

این نسخه یک بک‌اند واقعی اولیه برای AURORA دارد:

- Node.js + Express
- SQLite database
- احراز هویت Telegram Mini App با `initData` و HMAC
- حساب کاربری
- امتیاز
- تسک و ثبت انجام تسک
- رتبه‌بندی
- سیستم referral پایه
- ثبت reward در دیتابیس

## اجرای محلی

1. Node.js نصب باشد.
2. این پوشه را باز کن:
   ```bash
   npm install
   ```
3. فایل `.env.example` را به `.env` تبدیل کن.
4. مقدار `BOT_TOKEN` را از @BotFather وارد کن.
5. اجرا:
   ```bash
   npm start
   ```

سپس سرور روی `http://localhost:3000` بالا می‌آید.

## برای اجرای واقعی داخل Telegram

Mini App باید روی یک آدرس HTTPS عمومی deploy شود. بعد همان URL در تنظیمات Mini App ربات در BotFather قرار می‌گیرد.

## متغیرهای محیطی

- `BOT_TOKEN` = توکن واقعی ربات
- `BOT_USERNAME` = username ربات بدون @ (برای ساخت لینک referral)
- `PORT` = پورت
- `DB_PATH` = مسیر دیتابیس SQLite

## نکته امنیتی

توکن ربات را داخل GitHub commit نکن. فقط در Environment Variables سرویس hosting قرار بده.

این نسخه «هسته بک‌اند» است؛ برای production می‌توان بعداً PostgreSQL، پنل ادمین، تسک‌های واقعی، برداشت/پرداخت، محدودیت ضدتقلب و لاگینگ حرفه‌ای اضافه کرد.
