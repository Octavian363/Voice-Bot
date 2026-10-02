require('dotenv').config();
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, EndBehaviorType, getVoiceConnection, StreamType } = require('@discordjs/voice');
const Prism = require('prism-media');
const fs = require('fs');
const Groq = require('groq-sdk');
const path = require('path');
const https = require('https');

const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let isMuted = false;
let currentEnglishVoice = 'Brian'; 

let audioQueue = [];
let isPlaying = false;

const activeRecordingUsers = new Set();
const conversationMemory = {};

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const commands = [
    new SlashCommandBuilder().setName('join').setDescription('Make the bot join your voice channel and listen.'),
    new SlashCommandBuilder().setName('leave').setDescription('Make the bot leave the voice channel.'),
    new SlashCommandBuilder().setName('mute').setDescription('Mute the bot (it listens but won\'t speak).'),
    new SlashCommandBuilder().setName('unmute').setDescription('Unmute the bot.'),
    new SlashCommandBuilder().setName('voice').setDescription('Set your preferred English voice type.')
        .addStringOption(option => option.setName('type').setDescription('Voice name').setRequired(true))
].map(command => command.toJSON());

function nukeRecordingsFolder() {
    console.log('Running general cleanup in recordings folder...');
    try {
        const files = fs.readdirSync(RECORDINGS_DIR);
        for (const file of files) {
            const filePath = path.join(RECORDINGS_DIR, file);
            if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
            }
        }
        console.log('Recordings folder cleared completely!');
    } catch (error) {
        console.error('Error during general cleanup:', error);
    }
}

function enqueueAudio(audioFile, connection, filesToCleanup) {
    audioQueue.push({ audioFile, connection, filesToCleanup });
    processQueue();
}

function processQueue() {
    if (isPlaying || audioQueue.length === 0) return;
    isPlaying = true;

    const current = audioQueue.shift();
    
    if (!fs.existsSync(current.audioFile)) {
        cleanupFiles(...current.filesToCleanup);
        isPlaying = false;
        setTimeout(processQueue, 50);
        return;
    }

    const ffmpegStream = ffmpeg(current.audioFile)
        .toFormat('s16le')
        .audioChannels(2)
        .audioFrequency(48000)
        .pipe();

    const player = createAudioPlayer();

    player.on('error', (error) => {
        console.error(`Audio Player Safe Catch: ${error.message}`);
        cleanupFiles(...current.filesToCleanup, current.audioFile);
        isPlaying = false;
        setTimeout(processQueue, 200);
    });

    const resource = createAudioResource(ffmpegStream, {
        inputType: StreamType.Raw
    });

    current.connection.subscribe(player);
    player.play(resource);

    player.on('idle', () => {
        cleanupFiles(...current.filesToCleanup, current.audioFile);
        isPlaying = false;
        setTimeout(processQueue, 300); 
    });
}

function downloadTTSWithFallback(voiceType, text, dest, lang) {
    return new Promise((resolve, reject) => {
        const cleanText = text.replace(/["'\\]/g, '').trim();
        const encodedText = encodeURIComponent(cleanText);

        if (lang === 'ro') {
            const googleRoUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=ro&client=tw-ob`;
            return fetchDirectUrl(googleRoUrl, dest).then(resolve).catch(reject);
        }

        let targetRegion = lang; 
        if (lang === 'en') {
            if (voiceType === 'Brian') targetRegion = 'en-AU';
            else if (voiceType === 'Joey') targetRegion = 'en-IN';
            else if (voiceType === 'Emma') targetRegion = 'en-GB';
            else if (voiceType === 'Salli') targetRegion = 'en-US';
            else if (voiceType === 'Aditi') targetRegion = 'en-IN';
        }

        const primaryUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${targetRegion}&client=tw-ob`;

        fetchDirectUrl(primaryUrl, dest)
            .then(resolve)
            .catch(() => {
                const streamElementsUrl = `https://api.streamelements.com/v2/tts?voice=${voiceType}&text=${encodedText}`;
                fetchDirectUrl(streamElementsUrl, dest)
                    .then(resolve)
                    .catch(() => {
                        const absoluteBackupUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${lang}&client=tw-ob`;
                        fetchDirectUrl(absoluteBackupUrl, dest).then(resolve).catch(reject);
                    });
            });
    });
}

function fetchDirectUrl(targetUrl, dest) {
    return new Promise((resolve, reject) => {
        function performGet(url) {
            https.get(url, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    return performGet(response.headers.location);
                }
                if (response.statusCode !== 200) {
                    return reject(new Error(`Server returned status code ${response.statusCode}`));
                }
                const fileStream = fs.createWriteStream(dest);
                response.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });
                fileStream.on('error', (err) => {
                    fs.unlink(dest, () => {});
                    reject(err);
                });
            }).on('error', reject);
        }
        performGet(targetUrl);
    });
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMessages
    ]
});

client.once('clientReady', async () => {
    console.log(`Bot ${client.user.tag} is online and ready!`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Auto-deploy: Updating slash commands on Discord...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ Auto-deploy: All commands are successfully registered!');
    } catch (error) {
        console.error('❌ Auto-deploy failed:', error);
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const botConnection = getVoiceConnection(oldState.guild.id);
    if (!botConnection) return;

    const botChannelId = botConnection.joinConfig.channelId;
    
    if (oldState.channelId === botChannelId || newState.channelId === botChannelId) {
        const channel = oldState.guild.channels.cache.get(botChannelId);
        if (channel) {
            const humanMembers = channel.members.filter(m => !m.user.bot).size;
            if (humanMembers === 0) {
                console.log('No members left in channel. Leaving...');
                botConnection.destroy();
                audioQueue = [];
                isPlaying = false;
                activeRecordingUsers.clear();
                delete conversationMemory[oldState.guild.id]; 
                nukeRecordingsFolder(); 
            }
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply().catch(() => {});
        }

        if (interaction.commandName === 'voice') {
            const selectedVoice = interaction.options.getString('type');
            currentEnglishVoice = selectedVoice;
            return await interaction.editReply({ content: `Your voice preference has been switched to: **${selectedVoice}**!` });
        }

        if (interaction.commandName === 'mute') {
            isMuted = true;
            return await interaction.editReply({ content: 'Muted! I will no longer listen or respond until you use /unmute.' });
        }

        if (interaction.commandName === 'unmute') {
            isMuted = false;
            return await interaction.editReply({ content: 'Unmuted! I have started listening and speaking again.' });
        }

        if (interaction.commandName === 'leave') {
            const connection = getVoiceConnection(interaction.guild.id);
            if (connection) {
                connection.destroy();
                audioQueue = [];
                isPlaying = false;
                activeRecordingUsers.clear();
                delete conversationMemory[interaction.guild.id]; 
                nukeRecordingsFolder(); 
                return await interaction.editReply({ content: 'Bye! Left the voice channel.' });
            } else {
                return await interaction.editReply({ content: 'I am not in a voice channel!' });
            }
        }

        if (interaction.commandName === 'join') {
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) return await interaction.editReply({ content: 'Please join a voice channel first!' });

            isMuted = false;

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            conversationMemory[interaction.guild.id] = [];
            await interaction.editReply(`I joined! You can talk now.`);

            const initSession = `init_${Date.now()}`;
            const initOutput = path.join(RECORDINGS_DIR, `output_${initSession}.mp3`);
            
            try {
                await downloadTTSWithFallback(currentEnglishVoice, "Hello! I am Voice-Bot! Your personal assistant! Ask me anything!", initOutput, "en");
                if (fs.existsSync(initOutput)) enqueueAudio(initOutput, connection, []);
            } catch (ttsErr) {}

            const receiver = connection.receiver;

            receiver.speaking.on('start', (userId) => {
                if (isMuted) return;
                if (activeRecordingUsers.has(userId)) return; 

                activeRecordingUsers.add(userId);
                const sessionID = `${userId}_${Date.now()}`;
                
                const opusStream = receiver.subscribe(userId, {
                    end: { behavior: EndBehaviorType.AfterSilence, duration: 650 }
                });

                opusStream.on('error', (err) => {
                    if (err.message.includes('decrypt') || err.message.includes('DecryptionFailed')) {
                        return;
                    }
                    console.error("Opus Stream Error:", err);
                });

                const decoder = new Prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
                decoder.on('error', () => activeRecordingUsers.delete(userId));

                const pcmStream = opusStream.pipe(decoder);
                const rawFilename = path.join(RECORDINGS_DIR, `raw_${sessionID}.pcm`);
                const mp3Filename = path.join(RECORDINGS_DIR, `input_${sessionID}.mp3`);
                
                const writeStream = fs.createWriteStream(rawFilename);
                pcmStream.pipe(writeStream);

                writeStream.on('finish', () => {
                    if (isMuted) {
                        activeRecordingUsers.delete(userId);
                        cleanupFiles(rawFilename);
                        return;
                    }
                    
                    if (!fs.existsSync(rawFilename) || fs.statSync(rawFilename).size < 38000) {
                        activeRecordingUsers.delete(userId);
                        cleanupFiles(rawFilename);
                        return;
                    }

                    ffmpeg(rawFilename)
                        .inputOptions(['-f s16le', '-ar 16000', '-ac 1'])
                        .output(mp3Filename)
                        .on('end', async () => {
                            try {
                                if (isMuted) {
                                    activeRecordingUsers.delete(userId);
                                    cleanupFiles(rawFilename, mp3Filename);
                                    return;
                                }

                                const transcription = await groq.audio.transcriptions.create({
                                    file: fs.createReadStream(mp3Filename),
                                    model: 'whisper-large-v3-turbo'
                                });

                                const userText = transcription.text;
                                
                                if (!userText || userText.trim().length < 2 || 
                                    userText.toLowerCase().includes("thank you") || 
                                    userText.toLowerCase().includes("subtitles by")) {
                                    activeRecordingUsers.delete(userId);
                                    cleanupFiles(rawFilename, mp3Filename);
                                    return; 
                                }
                                console.log(`[User]: ${userText}`);

                                const guildId = interaction.guild.id;
                                if (!conversationMemory[guildId]) conversationMemory[guildId] = [];
                                conversationMemory[guildId].push({ role: 'user', content: userText });

                                if (conversationMemory[guildId].length > 20) conversationMemory[guildId].shift();

                                const systemPrompt = { 
                                    role: 'system', 
                                    content: `You are Voice-Bot, a highly adaptive, natural AI chatting on Discord.
                                    
                                    UNIVERSAL LANGUAGE RULE:
                                    1. You are 100% multilingual and can understand and speak ANY language in the world (Romanian, English, Spanish, German, French, etc.).
                                    2. ALWAYS detect the language the user is currently speaking. You MUST respond 100% in that exact same language.
                                    3. Be extremely smart: If the user speaks English but pronounces words poorly (e.g., "Ken Domo", "Dharma", "Watsakendama"), understand that they are talking about "Kendama" in English, and respond in English. Do not switch to Dutch, Ukrainian, or Russian unless they actually start speaking in those languages.
                                    
                                    FORMATTING:
                                    - Always output a strict JSON format with exactly two keys: 'text' (your response) and 'lang' (the ISO 2-letter code of the language, e.g., 'ro', 'en', 'fr', 'de', 'es').
                                    - Do not use any emojis. Keep responses to 1-2 short, natural sentences.`
                                };

                                const fullMessages = [systemPrompt, ...conversationMemory[guildId]];

                                const chatCompletion = await groq.chat.completions.create({
                                    messages: fullMessages,
                                    model: 'llama-3.1-8b-instant', 
                                    response_format: { type: "json_object" }
                                });

                                let botReplyText = "";
                                let detectedLang = "en";

                                try {
                                    const jsonResponse = JSON.parse(chatCompletion.choices[0].message.content);
                                    botReplyText = jsonResponse.text;
                                    detectedLang = jsonResponse.lang || "en";
                                } catch (parseError) {
                                    botReplyText = chatCompletion.choices[0].message.content;
                                    detectedLang = "en";
                                }

                                console.log(`[Voice-bot] [Lang: ${detectedLang}]: ${botReplyText}`);
                                conversationMemory[guildId].push({ role: 'assistant', content: chatCompletion.choices[0].message.content });

                                const outputFilename = path.join(RECORDINGS_DIR, `output_${sessionID}.mp3`);
                                
                                await downloadTTSWithFallback(currentEnglishVoice, botReplyText, outputFilename, detectedLang);

                                activeRecordingUsers.delete(userId);

                                if (fs.existsSync(outputFilename) && fs.statSync(outputFilename).size > 100) {
                                    enqueueAudio(outputFilename, connection, [rawFilename, mp3Filename]);
                                } else {
                                    cleanupFiles(rawFilename, mp3Filename);
                                }

                            } catch (error) {
                                console.error("[Safe Engine Catch] Error processing dialogue:", error.message);
                                activeRecordingUsers.delete(userId);
                                cleanupFiles(rawFilename, mp3Filename);
                            }
                        })
                        .on('error', () => {
                            activeRecordingUsers.delete(userId);
                            cleanupFiles(rawFilename, mp3Filename);
                        })
                        .run();
                });
            });
        }
    } catch (err) {
        console.error("Interaction Error caught safely:", err);
    }
});

function cleanupFiles(...files) {
    files.forEach(file => {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
    });
}

client.login(process.env.DISCORD_TOKEN);