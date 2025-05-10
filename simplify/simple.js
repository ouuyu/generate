const ExcelJS = require('exceljs');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL
});

const EXCEL_FILE = 'word.xlsx';
const OUTPUT_FILE = 'simplified_meanings.json';
const BATCH_SIZE = 100;
const DELAY_BETWEEN_BATCHES_MS = 1500;

async function processWords() {
  let simplifiedMeanings = [];
  const processedWords = new Set();

  console.log(`正在尝试加载已有的结果文件: ${OUTPUT_FILE}`);
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const existingData = fs.readFileSync(OUTPUT_FILE, 'utf8');
      if (existingData.trim()) {
          simplifiedMeanings = JSON.parse(existingData);
          console.log(`成功加载 ${simplifiedMeanings.length} 个已有条目。`);
          simplifiedMeanings.forEach(item => {
            if (item && typeof item.word === 'string') {
              processedWords.add(item.word.toLowerCase());
            }
          });
          console.log(`已标记 ${processedWords.size} 个单词为已处理。`);
      } else {
          console.log('已存在结果文件，但为空。将从头开始处理。');
      }
    } catch (error) {
      console.error(`加载或解析已有结果文件出错: ${error.message}. 将从头开始处理。`);
      simplifiedMeanings = [];
      processedWords.clear();
    }
  } else {
    console.log('结果文件不存在，将从头开始处理。');
  }


  console.log(`正在读取 Excel 文件: ${EXCEL_FILE}`);
  const workbook = new ExcelJS.Workbook();
  let wordDataToProcess = [];
  const seenWordsInExcel = new Set();

  try {
    await workbook.xlsx.readFile(EXCEL_FILE);
    const worksheet = workbook.getWorksheet(1);

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        return;
      }
      const wordCell = row.getCell(1).value;
      const translationCell = row.getCell(2).value;

      const word = typeof wordCell === 'object' && wordCell !== null && 'text' in wordCell ? wordCell.text : String(wordCell || '').trim();
      const translation = typeof translationCell === 'object' && translationCell !== null && 'text' in translationCell ? translationCell.text : String(translationCell || '').trim();


      if (word && translation) {
        const lowerWord = word.toLowerCase();

        if (seenWordsInExcel.has(lowerWord)) {
          return;
        }
        seenWordsInExcel.add(lowerWord);

        if (processedWords.has(lowerWord)) {
           return;
        }

        wordDataToProcess.push({ word: word, translation: translation });

      } else {
      }
    });

    console.log(`成功读取 ${seenWordsInExcel.size} 个唯一的 Excel 条目。`);
    console.log(`本次需要处理 ${wordDataToProcess.length} 个新单词。`);

  } catch (error) {
    console.error(`读取 Excel 文件时出错: ${error.message}`);
    process.exit(1);
  }

  const totalWordsToProcess = wordDataToProcess.length;
  if (totalWordsToProcess === 0) {
      console.log("没有需要处理的新单词。程序退出。");
      return;
  }


  for (let i = 0; i < totalWordsToProcess; i += BATCH_SIZE) {
    const batch = wordDataToProcess.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(totalWordsToProcess / BATCH_SIZE);
    console.log(`正在处理批次 ${batchNumber}/${totalBatches} (${batch.length} 个单词)...`);

    const promptMessages = [
      { role: 'system', content: '你是一个乐于助人的助手，可以将单词翻译简化为简洁的含义并识别主要词性。你的输出必须严格是 JSON 格式的数据，不包含任何额外文字或格式标记。' },
      { role: 'user', content: `
      请为以下单词-翻译对确定主要词性（如 n., v., a., adv. 等），并将其含义简化为极其简短、简洁的解释，每个解释不超过 10 个字，请自行提炼。

      你的输出必须严格是一个 JSON 数组，格式为：
      \`[{"word": "单词", "pos": "词性", "meaning": "简短含义"}, {"word": "单词", "pos": "词性", "meaning": "简短含义"}, ...]\`

      请务必严格遵循此格式，**不要**在 JSON 数组前后添加任何文本、说明或 Markdown 代码块（如 \`\`\`json）。

      需要简化的单词对：
      ${JSON.stringify(batch.map(item => ({ word: item.word, translation: item.translation })))}
      `}
    ];

    let batchMeanings = [];
    try {
      const response = await openai.chat.completions.create({
        model: 'internlm/internlm2_5-20b-chat',
        messages: promptMessages,
        response_format: { type: "json_object" },
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn(`批次 ${batchNumber} API 响应内容为空，跳过此批次。`);
        continue;
      }

      try {
        const parsedResponse = JSON.parse(content);

        if (Array.isArray(parsedResponse) && parsedResponse.every(item =>
            item && typeof item.word === 'string' && typeof item.pos === 'string' && typeof item.meaning === 'string'
        )) {
           batchMeanings = parsedResponse.map(item => ({ word: item.word.trim(), pos: item.pos.trim(), meaning: item.meaning.trim() }));
           console.log(`成功处理批次 ${batchNumber}, 生成了 ${batchMeanings.length} 个简略释义。`);
        } else {
          console.warn(`批次 ${batchNumber} API 响应格式不完全正确，可能不是预期的JSON数组或缺少字段。内容: ${content}`);
          batchMeanings = [];
        }

      } catch (jsonError) {
        console.error(`批次 ${batchNumber} JSON 解析失败: ${jsonError.message}. 响应内容: ${content}`);
        batchMeanings = [];
      }

    } catch (apiError) {
      console.error(`调用 OpenAI API 时出错 (批次 ${batchNumber}): ${apiError.message}`);
      batchMeanings = [];
    }

    simplifiedMeanings.push(...batchMeanings);

    try {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(simplifiedMeanings, null, 2), 'utf8');
      console.log(`已将批次 ${batchNumber} 的结果实时保存到文件: ${OUTPUT_FILE}`);
    } catch (writeError) {
      console.error(`写入 JSON 文件时出错 (批次 ${batchNumber}): ${writeError.message}`);
    }

    if (i + BATCH_SIZE < totalWordsToProcess) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  console.log(`所有待处理批次处理完成。最终总共 ${simplifiedMeanings.length} 个条目保存在文件 ${OUTPUT_FILE} 中。`);
}

processWords();