import type { Language } from "./index";
const en = {
  welcome:
    "Welcome to CloseMe. Meet real people, discover matches and start meaningful conversations. You must be 18 or older to use CloseMe.",
  adult: "I am 18 or older",
  underage: "I am under 18",
  denied: "CloseMe is only available to adults aged 18 and over.",
  dob: "Enter your date of birth: YYYY-MM-DD (for example, 2000-05-21).",
  contact:
    "Verify your phone using the button below. Your number is private; we store a secure fingerprint, not your raw phone number.",
  share: "Share my contact",
  wrong_contact: "Please share your own Telegram contact using the button.",
  username:
    "Choose your CloseMe username: 2–25 letters or digits. This is separate from your Telegram username.",
  invalid: "Use only 2–25 Latin letters or digits.",
  premium:
    "💎 Premium username. One-character usernames can only be assigned by CloseMe.",
  taken: "This username is already taken. Please choose another.",
  reserved: "This username is reserved.",
  frozen: "This username is frozen.",
  done: "Your CloseMe username: @{username}. Let’s create your relationship profile.",
  error: "Unable to complete that action. Please try again.",
  limited: "Too many attempts. Please wait before trying again.",
  start: "Send /start to continue setup.",
  dob_invalid: "Enter a valid date using YYYY-MM-DD.",
  unavailable: "This account is unavailable. Contact CloseMe support.",
  help: "CloseMe setup: /start. Only adults 18+. Your phone number and Telegram identity are not shared with other members.",
};
type Dictionary = { [K in keyof typeof en]: string };
const uz: Dictionary = {
  welcome:
    "CloseMe’ga xush kelibsiz. Yangi insonlar bilan tanishing va mazmunli munosabatlar boshlang. Xizmat faqat 18 yoshdan kattalar uchun.",
  adult: "18 yoshga to‘lganman",
  underage: "18 yoshga to‘lmaganman",
  denied: "CloseMe faqat 18 yoshga to‘lganlar uchun.",
  dob: "Tug‘ilgan sanangizni yozing: YYYY-MM-DD (masalan, 2000-05-21).",
  contact:
    "Quyidagi tugma bilan o‘z kontaktingizni yuboring. Telefon raqamingiz maxfiy; raqam o‘rniga himoyalangan xesh saqlanadi.",
  share: "Kontaktimni yuborish",
  wrong_contact: "Tugma orqali o‘zingizning Telegram kontaktingizni yuboring.",
  username:
    "CloseMe username tanlang: 2–25 ta lotin harfi yoki raqam. Bu Telegram username’ingizdan alohida.",
  invalid: "Faqat 2–25 ta lotin harfi yoki raqam kiriting.",
  premium:
    "💎 Premium username. Bitta belgili username’ni faqat CloseMe tayinlaydi.",
  taken: "Bu username band. Boshqasini tanlang.",
  reserved: "Bu username zaxiralangan.",
  frozen: "Bu username muzlatilgan.",
  done: "CloseMe username’ingiz: @{username}. Tanishtiruv profilingizni yarating.",
  error: "Amal bajarilmadi. Qayta urinib ko‘ring.",
  limited: "Juda ko‘p urinish. Biroz kuting.",
  start: "Davom etish uchun /start yuboring.",
  dob_invalid: "Sanani YYYY-MM-DD shaklida to‘g‘ri kiriting.",
  unavailable:
    "Bu hisobdan foydalanish cheklangan. CloseMe yordam xizmatiga murojaat qiling.",
  help: "CloseMe sozlash: /start. Faqat 18+. Telefon raqamingiz va Telegram profilingiz boshqa foydalanuvchilarga ko‘rsatilmaydi.",
};
const ru: Dictionary = {
  welcome:
    "Добро пожаловать в CloseMe. Знакомьтесь с людьми и начинайте значимые отношения. Сервис доступен только с 18 лет.",
  adult: "Мне уже 18 лет",
  underage: "Мне нет 18 лет",
  denied: "CloseMe доступен только совершеннолетним от 18 лет.",
  dob: "Введите дату рождения: YYYY-MM-DD (например, 2000-05-21).",
  contact:
    "Подтвердите свой номер кнопкой ниже. Номер приватный: мы храним защищённый отпечаток, а не сам номер.",
  share: "Поделиться своим контактом",
  wrong_contact: "Отправьте свой контакт Telegram с помощью кнопки.",
  username:
    "Выберите имя CloseMe: 2–25 латинских букв или цифр. Оно не связано с вашим именем в Telegram.",
  invalid: "Используйте только 2–25 латинских букв или цифр.",
  premium: "💎 Премиальное имя. Односимвольные имена назначает только CloseMe.",
  taken: "Это имя уже занято. Выберите другое.",
  reserved: "Это имя зарезервировано.",
  frozen: "Это имя заморожено.",
  done: "Ваше имя CloseMe: @{username}. Создайте профиль для знакомства.",
  error: "Не удалось выполнить действие. Попробуйте снова.",
  limited: "Слишком много попыток. Подождите немного.",
  start: "Отправьте /start для продолжения.",
  dob_invalid: "Введите корректную дату в формате YYYY-MM-DD.",
  unavailable: "Этот аккаунт недоступен. Обратитесь в поддержку CloseMe.",
  help: "Настройка CloseMe: /start. Только 18+. Ваш номер и профиль Telegram не раскрываются другим пользователям.",
};
export const dictionaries = { en, uz, ru };
export function t(
  locale: Language,
  key: keyof Dictionary,
  params: Record<string, string> = {},
): string {
  return dictionaries[locale][key].replace(
    /\{(\w+)\}/g,
    (_, k: string) => params[k] ?? "",
  );
}
