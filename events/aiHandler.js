const axios = require('axios');
const { MongoClient } = require('mongodb');
const config = require('../config.json');
const { AttachmentBuilder } = require('discord.js');

module.exports = async (client) => {
  const mongo = new MongoClient(config.mongodbUri);
  await mongo.connect();
  const db = mongo.db('shapeBot');
  const dedicatedCol = db.collection('dedicatedChannels');

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (message.author.id === client.user.id) return;

    const mentionRegex = new RegExp(`^<@!?${client.user.id}>`);
    const isMention = mentionRegex.test(message.content.trim());
    const isCommand = message.content.startsWith('!s ');
    const isReplyToBot = message.reference && message.mentions.repliedUser?.id === client.user.id;

    const dedicated = await dedicatedCol.findOne({ guildId: message.guildId });
    const isDedicatedChannel = dedicated?.channelId === message.channel.id;

    const isIAForced = isMention || isCommand || isReplyToBot || isDedicatedChannel;
    const shouldRespondByChance = config.enablePassiveIA && Math.random() < 0.10;
    const isPassiveTrigger = !isIAForced && shouldRespondByChance;

    if (!isIAForced && !isPassiveTrigger) return;

    await message.channel.sendTyping();

    const promptRaw = message.content
      .replace(mentionRegex, '')
      .replace(/^!s /, '')
      .trim();

    const username = message.member?.nickname || message.author.username;
    const promptText = promptRaw ? `Usuário ${username} disse: ${promptRaw}` : null;

    const attachments = message.attachments;
    let imageUrl = null;
    let audioUrl = null;

    attachments.forEach(att => {
      const url = att.url.toLowerCase();
      if (url.match(/\.(jpg|jpeg|png|webp)$/)) imageUrl = att.url;
      if (url.match(/\.(mp3|wav|ogg)$/)) audioUrl = att.url;
    });

    let contentPayload = [];

    if (promptText) contentPayload.push({ type: 'text', text: promptText });
    if (audioUrl) contentPayload.push({ type: 'audio_url', audio_url: { url: audioUrl } });
    else if (imageUrl) contentPayload.push({ type: 'image_url', image_url: { url: imageUrl } });

    let finalPayload = {
      prompt: contentPayload.length === 1 && contentPayload[0].type === 'text'
        ? contentPayload[0].text
        : contentPayload,
      user_id: message.author.id,
      channel_id: message.channel.id
    };

    if (isPassiveTrigger) {
      try {
        const messages = await message.channel.messages.fetch({ limit: 10 });
        const recentMessages = [...messages.values()]
          .filter(msg => !msg.author.bot)
          .reverse()
          .map(msg => ({ user: msg.member?.nickname || msg.author.username, message: msg.content }));

        const assuntoGemini = await axios.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
          {
            contents: [{ parts: [{ text: `Dois usuários estão conversando. Estas são as mensagens:\n${JSON.stringify(recentMessages)}\nDescreva o assunto diretamente.` }] }]
          },
          { params: { key: process.env.GEMINI_API_KEY } }
        );

        const assunto = assuntoGemini.data.candidates?.[0]?.content?.parts?.[0]?.text || 'nada detectado';

        const decisaoGemini = await axios.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
          {
            contents: [{ parts: [{ text: `Dois usuários estão falando sobre ${assunto}. Se for apropriado o bot interagir, diga apenas "true". Senão, diga "false".` }] }]
          },
          { params: { key: process.env.GEMINI_API_KEY } }
        );

        const decisao = decisaoGemini.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase();
        if (decisao !== 'true') return;

        finalPayload.prompt = JSON.stringify(recentMessages);
      } catch (err) {
        console.warn('Gemini error:', err.message);
        return;
      }
    }

    try {
      const { data } = await axios.post(process.env.SHAPES_RELAY_URL, finalPayload, { timeout: 30000 });
      let resposta = data.response;

      const callbacks = {
        deepthink: /<Deepthink:\s*(.*?)>/gi,
        image: /<imageGenerate:\s*(.*?)>/gi,
        codeSimple: /<codeSimple(?:(.*?))?:\s*(.*?)>/gi
      };

      let callbackEncontrado = false;

      for (const [tipo, regex] of Object.entries(callbacks)) {
        let match;
        while ((match = regex.exec(resposta)) !== null) {
          callbackEncontrado = true;

          switch (tipo) {
            case "deepthink":
              const raciocinio = `<raciocínio>: O usuário deseja: ${match[1]}. O que você acha que deve ser feito?`;
              const r = await axios.post(process.env.SHAPES_RELAY_URL, {
                prompt: raciocinio,
                user_id: message.author.id,
                channel_id: message.channel.id
              });
              resposta = r.data.response;
              break;

case "image":
  console.log(`[CALLBACK] Solicitando imagem para: ${match[1]}`);
  const imageRes = await require('../events/toolManager')({
    tool: "gerarImagem",
    input: match[1]
  });
  console.log('[CALLBACK] Resposta recebida da toolManager:', imageRes);
  await message.reply(imageRes);
  break;


            case "codeSimple":
              const extSimple = match[1] || 'txt';
              const codePrompt = match[2];
              const codeRes = await require('../events/toolManager')({
                tool: "criarCodigo",
                input: codePrompt,
                extension: extSimple
              });
              await message.reply(codeRes);
              break;
          }
        }
      }

      if (!callbackEncontrado) {
        await message.reply(resposta);
      }

    } catch (err) {
      console.error('Erro ao consultar Relay:', err.message);
      await message.reply('❌ Erro ao consultar a IA.');
    }
  });
};