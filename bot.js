require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const express = require("express");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is missing. Set it in environment variables.");
  process.exit(1);
}

const bot = new Telegraf(token);

// ⚠️ Для простоты пока хранение в памяти (сбросится при перезапуске Render).
const sessions = new Map();

const AGE_TAGS = [
  "#возраст_0_6мес",
  "#возраст_6_9мес",
  "#возраст_9_12мес",
  "#возраст_1_2",
  "#возраст_2_3",
  "#возраст_3_4",
  "#возраст_4_5",
  "#возраст_5_7",
];

const TOPICS = {
  toys: { key: "toys", title: "игрушки", hashtag: "#игры", implemented: false },
  books: { key: "books", title: "книги", hashtag: "#книги", implemented: true },
  activities: { key: "activities", title: "занятия", hashtag: "#занятия", implemented: true },
  places: { key: "places", title: "места", hashtag: "#места", implemented: false },
  specialists: { key: "specialists", title: "специалисты", hashtag: "#специалисты", implemented: false },
  recipes: { key: "recipes", title: "рецепты", hashtag: "#рецепты", implemented: false },
  onroad: { key: "onroad", title: "в дороге", hashtag: "#в_дороге", implemented: false },
  cartoons: { key: "cartoons", title: "мультфильмы", hashtag: "#мультфильмы", implemented: false },
  guides: { key: "guides", title: "гайды", hashtag: "#гайды", implemented: false },
};

const TOPIC_ORDER = [
  "toys",
  "books",
  "activities",
  "places",
  "specialists",
  "recipes",
  "onroad",
  "cartoons",
  "guides",
];

const FLOWS = {
  books: [
    { key: "bookTitle", prompt: "Название книги?" },
    { key: "bookAuthor", prompt: "Автор книги?" },
    { key: "whyLike", prompt: "Почему рекомендуете эту книгу?" },
    { key: "ageTag", prompt: "Выберите возрастной тег:", type: "age_tag" },
    { key: "whereFound", prompt: 'Ссылка/где купить? (можно написать "-" если не указывать)' },
  ],
  activities: [
    { key: "activityTitle", prompt: "Название занятия?" },
    { key: "goal", prompt: "Цель занятия (что развиваем)?" },
    {
      key: "materials",
      prompt:
        "Вам понадобится (каждый материал с новой строки).\n" +
        "Можно добавить ссылку через |, например:\n" +
        "Картон|https://example.com\n" +
        "Ножницы\n" +
        "Клей|https://example.com",
    },
    { key: "steps", prompt: "Кратко опишите шаги проведения занятия." },
    { key: "ageTag", prompt: "Выберите возрастной тег:", type: "age_tag" },
  ],
};

function getSession(userId) {
  return sessions.get(userId);
}

function setSession(userId, data) {
  sessions.set(userId, data);
}

function clearSession(userId) {
  sessions.delete(userId);
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function topicKeyboard() {
  const rows = [];
  for (let i = 0; i < TOPIC_ORDER.length; i += 2) {
    const first = TOPICS[TOPIC_ORDER[i]];
    const second = TOPICS[TOPIC_ORDER[i + 1]];
    const row = [Markup.button.callback(first.title, `topic:${first.key}`)];
    if (second) row.push(Markup.button.callback(second.title, `topic:${second.key}`));
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

function currentStep(session) {
  return FLOWS[session.topic]?.[session.stepIndex];
}

async function askCurrentStep(ctx, session) {
  const step = currentStep(session);
  if (!step) {
    await finishFlow(ctx, session);
    return;
  }

  if (step.type === "age_tag") {
    const ageButtons = AGE_TAGS.map((tag) => [Markup.button.callback(tag, `age:${tag}`)]);
    await ctx.reply(step.prompt, Markup.inlineKeyboard(ageButtons));
    return;
  }

  await ctx.reply(step.prompt);
}

function formatMaterials(materialsText) {
  if (!materialsText) return "";

  return materialsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawName, rawUrl] = line.split("|").map((part) => part.trim());
      const material = escapeHtml(rawName || "Материал");

      if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
        return `— ${material} (<a href='${escapeHtml(rawUrl)}'>купить</a>)`;
      }
      return `— ${material}`;
    })
    .join("\n");
}

function buildBookPost(data) {
  const lines = [
    "<b>📚 Рекомендация книги</b>",
    "",
    `<b>Название:</b> ${escapeHtml(data.bookTitle)}`,
    `<b>Автор:</b> ${escapeHtml(data.bookAuthor)}`,
    `<b>Почему рекомендую:</b> ${escapeHtml(data.whyLike)}`,
  ];

  if (data.whereFound && data.whereFound.trim() !== "-") {
    lines.push(`<b>Где найти/купить:</b> ${escapeHtml(data.whereFound)}`);
  }

  lines.push("", "📷 При публикации добавьте фото/видео.", "");
  lines.push(`${TOPICS.books.hashtag} ${data.ageTag}`);

  return lines.join("\n");
}

function buildActivitiesPost(data) {
  const lines = [
    "<b>🧩 Идея занятия</b>",
    "",
    `<b>Название:</b> ${escapeHtml(data.activityTitle)}`,
    `<b>Цель:</b> ${escapeHtml(data.goal)}`,
    "<b>Вам понадобится:</b>",
    formatMaterials(data.materials),
    `<b>Шаги:</b> ${escapeHtml(data.steps)}`,
    "",
    "📷 При публикации добавьте фото/видео.",
    "",
    `${TOPICS.activities.hashtag} ${data.ageTag}`,
  ];

  return lines.join("\n");
}

async function finishFlow(ctx, session) {
  let post = "";

  if (session.topic === "books") post = buildBookPost(session.answers);
  if (session.topic === "activities") post = buildActivitiesPost(session.answers);

  if (!post) {
    await ctx.reply("Тема в разработке. Попробуйте позже.");
    clearSession(ctx.from.id);
    return;
  }

  await ctx.reply("<b>Готовый пост:</b>", { parse_mode: "HTML" });
  await ctx.reply(post, { parse_mode: "HTML", disable_web_page_preview: true });
  await ctx.reply("Скопируйте текст и опубликуйте вручную. Бот не публикует посты автоматически.");
  clearSession(ctx.from.id);
}

async function startFlow(ctx, topicKey) {
  const topic = TOPICS[topicKey];
  if (!topic) return;

  if (!topic.implemented) {
    await ctx.reply(`Тема «${topic.title}» в разработке.`);
    return;
  }

  const session = { topic: topicKey, stepIndex: 0, answers: {} };
  setSession(ctx.from.id, session);

  await ctx.reply(`Тема выбрана: ${topic.title}. Начинаем анкету.\nКоманды: /back, /cancel`);
  await askCurrentStep(ctx, session);
}

// -------------------- HANDLERS --------------------

bot.start(async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("Привет! Я помогу подготовить пост.\nКоманды: /post, /cancel, /back, /restart");
});

bot.command("restart", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("Сессия сброшена. Начинаем заново. Нажмите /post для нового поста.");
});

bot.command("cancel", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("Анкета отменена. Чтобы начать снова, используйте /post.");
});

bot.command("post", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("Выберите тему поста:", topicKeyboard());
});

bot.command("back", async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session) {
    await ctx.reply("Нет активной анкеты. Используйте /post.");
    return;
  }

  if (session.stepIndex === 0) {
    await ctx.reply("Это первый шаг. Нельзя вернуться назад.");
    return;
  }

  const prevStep = FLOWS[session.topic][session.stepIndex - 1];
  delete session.answers[prevStep.key];
  session.stepIndex -= 1;
  setSession(ctx.from.id, session);

  await ctx.reply("Вернулись на шаг назад.");
  await askCurrentStep(ctx, session);
});

bot.action(/^topic:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const topicKey = ctx.match[1];
  await startFlow(ctx, topicKey);
});

bot.action(/^age:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);

  if (!session) {
    await ctx.reply("Нет активной анкеты. Используйте /post.");
    return;
  }

  const step = currentStep(session);
  if (!step || step.type !== "age_tag") {
    await ctx.reply("Сейчас этот выбор не требуется.");
    return;
  }

  const selectedAgeTag = ctx.match[1];
  if (!AGE_TAGS.includes(selectedAgeTag)) {
    await ctx.reply("Неизвестный возрастной тег.");
    return;
  }

  session.answers[step.key] = selectedAgeTag;
  session.stepIndex += 1;
  setSession(ctx.from.id, session);

  await askCurrentStep(ctx, session);
});

bot.on("text", async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session) return;

  const step = currentStep(session);
  if (!step) return;

  if (step.type === "age_tag") {
    await ctx.reply("Пожалуйста, выберите возрастной тег кнопкой ниже.");
    await askCurrentStep(ctx, session);
    return;
  }

  session.answers[step.key] = (ctx.message.text || "").trim();
  session.stepIndex += 1;
  setSession(ctx.from.id, session);

  await askCurrentStep(ctx, session);
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  if (ctx && ctx.reply) ctx.reply("Произошла ошибка. Попробуйте /restart.");
});

// -------------------- WEBHOOK SERVER (RENDER) --------------------

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram/webhook";
const WEBHOOK_URL = process.env.WEBHOOK_URL; // https://mom-chat-bot.onrender.com

app.get("/", (_req, res) => res.status(200).send("OK"));
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start() {
  if (!WEBHOOK_URL) {
    console.error("WEBHOOK_URL is missing. Set it in environment variables.");
    process.exit(1);
  }

  const fullWebhookUrl = `${WEBHOOK_URL}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(fullWebhookUrl);

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Webhook set to ${fullWebhookUrl}`);
  });
}

start().catch((err) => {
  console.error("Failed to start webhook server:", err);
  process.exit(1);
});
