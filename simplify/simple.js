const ExcelJS = require('exceljs');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL
});

const EXCEL_FILE = 'word.xlsx'; // Excel文件名
const OUTPUT_FILE = 'simplify/simplified_meanings.json'; // 输出JSON文件名
const BATCH_SIZE = 50; // 每个LLM请求中包含的单词数量
const DELAY_BETWEEN_BATCHES_MS = 100; // 每组并发请求之间的延迟（毫秒）
const MAX_CONCURRENT_REQUESTS = 15; // 最大并发LLM请求数量

/**
 * 处理单个批次的单词数据，调用LLM获取释义。
 * @param {Array<Object>} batchData - 当前批次的单词数据 {word, translation}
 * @param {number} logicalBatchNumber - 当前批次的逻辑编号 (用于日志)
 * @returns {Promise<Array<Object>>} - Promise，解析为该批次获取到的释义数组
 */
async function processBatchForLLM(batchData, logicalBatchNumber) {
  const promptMessages = [
    { role: 'system', content: '你是一个乐于助人的助手，可以将单词翻译简化为简洁的含义并识别主要词性。你的输出必须严格是 JSON 格式的数据，不包含任何额外文字或格式标记。' },
    { role: 'user', content: `
    请为以下单词-翻译对确定主要词性（如 n., v., a., adv. 等），并将其含义简化为极其简短、简洁的解释，每个解释不超过 10 个字，请自行提炼。

    你的输出必须严格是一个 JSON 数组，格式为：
    \`[{"word": "单词", "pos": "词性", "meaning": "简短含义"}, {"word": "单词", "pos": "词性", "meaning": "简短含义"}, ...]\`

    请务必严格遵循此格式，**不要**在 JSON 数组前后添加任何文本、说明或 Markdown 代码块（如 \`\`\`json）。

    需要简化的单词对：
    ${JSON.stringify(batchData.map(item => ({ word: item.word, translation: item.translation })))}
    `}
  ];

  console.log(`正在发送逻辑批次 ${logicalBatchNumber} (${batchData.length} 个单词) 至 LLM...`);

  let batchMeanings = [];
  try {
    const response = await openai.chat.completions.create({
      model: 'LoRA/Qwen/Qwen2.5-72B-Instruct', // 请确保模型名称正确
      messages: promptMessages,
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.warn(`LLM API 对逻辑批次 ${logicalBatchNumber} 的响应内容为空。`);
      return []; // 内容为空则此批次返回空数组
    }

    try {
      const parsedResponse = JSON.parse(content);

      if (Array.isArray(parsedResponse) && parsedResponse.every(item =>
        item && typeof item.word === 'string' && typeof item.pos === 'string' && typeof item.meaning === 'string'
      )) {
        batchMeanings = parsedResponse.map(item => ({
          word: item.word.trim(),
          pos: item.pos.trim(),
          meaning: item.meaning.trim()
        }));
        console.log(`成功处理逻辑批次 ${logicalBatchNumber}, 生成了 ${batchMeanings.length} 个简略释义。`);
      } else {
        console.warn(`逻辑批次 ${logicalBatchNumber} API 响应格式不完全正确，可能不是预期的JSON数组或缺少字段。内容片段: ${content.substring(0, 200)}...`);
        // 如果LLM返回的是 {"some_key": [...]}, 这里需要调整。但根据prompt，它应该直接返回数组。
      }
    } catch (jsonError) {
      console.error(`逻辑批次 ${logicalBatchNumber} JSON 解析失败: ${jsonError.message}. 响应内容片段: ${content.substring(0, 200)}...`);
    }
  } catch (apiError) {
    console.error(`调用 OpenAI API 处理逻辑批次 ${logicalBatchNumber} 时出错: ${apiError.message}`);
    throw apiError; // 抛出错误，由 Promise.all 的 .catch 处理
  }
  return batchMeanings;
}

async function processWords() {
  let simplifiedMeanings = []; // 存储所有已处理的单词释义
  const processedWords = new Set(); // 存储已处理单词的小写形式，用于去重

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
  let wordDataToProcess = []; // 存储本次需要处理的单词数据
  const seenWordsInExcel = new Set(); // 存储在Excel中已见过的单词，防止Excel内部重复

  try {
    await workbook.xlsx.readFile(EXCEL_FILE);
    const worksheet = workbook.getWorksheet(1); // 获取第一个工作表

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) { // 跳过表头行
        return;
      }
      const wordCell = row.getCell(1).value;
      const translationCell = row.getCell(2).value;

      const word = typeof wordCell === 'object' && wordCell !== null && 'text' in wordCell ? wordCell.text : String(wordCell || '').trim();
      const translation = typeof translationCell === 'object' && translationCell !== null && 'text' in translationCell ? translationCell.text : String(translationCell || '').trim();

      if (word && translation) {
        const lowerWord = word.toLowerCase();

        if (seenWordsInExcel.has(lowerWord)) { // 如果Excel中此单词已出现过，则跳过
          return;
        }
        seenWordsInExcel.add(lowerWord);

        if (processedWords.has(lowerWord)) { // 如果此单词之前已处理过（从JSON加载的），则跳过
            return;
        }
        wordDataToProcess.push({ word: word, translation: translation });
      }
    });

    console.log(`成功读取 ${seenWordsInExcel.size} 个唯一的 Excel 条目。`);
    console.log(`本次需要处理 ${wordDataToProcess.length} 个新单词。`);

  } catch (error) {
    console.error(`读取 Excel 文件时出错: ${error.message}`);
    process.exit(1); // 读取失败则退出
  }

  const totalWordsToProcessCount = wordDataToProcess.length;
  if (totalWordsToProcessCount === 0) {
    console.log("没有需要处理的新单词。程序退出。");
    return;
  }

  // 将所有待处理单词按 BATCH_SIZE 分割成小批次
  const allBatchesData = [];
  for (let i = 0; i < totalWordsToProcessCount; i += BATCH_SIZE) {
    allBatchesData.push(wordDataToProcess.slice(i, i + BATCH_SIZE));
  }
  const totalLogicalBatches = allBatchesData.length;
  console.log(`将 ${totalWordsToProcessCount} 个单词分为 ${totalLogicalBatches} 个逻辑批次进行处理。每批最多 ${BATCH_SIZE} 个单词。`);

  // 按 MAX_CONCURRENT_REQUESTS 的数量并发处理这些逻辑批次
  for (let i = 0; i < totalLogicalBatches; i += MAX_CONCURRENT_REQUESTS) {
    const concurrentBatchChunk = allBatchesData.slice(i, i + MAX_CONCURRENT_REQUESTS);
    const promises = [];

    console.log(`准备并发处理 ${concurrentBatchChunk.length} 个逻辑批次 (从 ${i + 1} 到 ${i + concurrentBatchChunk.length} / 总共 ${totalLogicalBatches})...`);

    concurrentBatchChunk.forEach((singleBatchData, indexInChunk) => {
      const logicalBatchNumber = i + 1 + indexInChunk; // 当前处理的逻辑批次编号
      promises.push(
        processBatchForLLM(singleBatchData, logicalBatchNumber)
          .catch(error => {
            // 捕获 processBatchForLLM 内部未处理的错误或其抛出的错误
            // 错误已在 processBatchForLLM 内部打印，这里确保返回空数组使 Promise.all 继续
            console.error(`处理逻辑批次 ${logicalBatchNumber} 时捕获到顶层错误: ${error.message}`);
            return []; // 对于失败的批次，返回空数组，不中断其他并发请求
          })
      );
    });

    if (promises.length > 0) {
      // 等待当前并发集合中的所有请求完成
      const resultsFromConcurrentSet = await Promise.all(promises);

      let newMeaningsInThisSet = 0;
      resultsFromConcurrentSet.forEach(batchMeanings => {
        if (Array.isArray(batchMeanings) && batchMeanings.length > 0) {
          simplifiedMeanings.push(...batchMeanings);
          newMeaningsInThisSet += batchMeanings.length;
        }
      });

      console.log(`此并发集合处理完成。新增 ${newMeaningsInThisSet} 条释义。`);

      try {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(simplifiedMeanings, null, 2), 'utf8');
        console.log(`已将结果实时保存到文件: ${OUTPUT_FILE}。目前包含 ${simplifiedMeanings.length} 个条目。`);
      } catch (writeError) {
        console.error(`并发集合处理后写入 JSON 文件时出错: ${writeError.message}`);
      }
    }

    // 如果这不是最后一组并发批处理，则延迟
    if (i + MAX_CONCURRENT_REQUESTS < totalLogicalBatches && promises.length > 0) {
      console.log(`在下一组并发批处理请求前延迟 ${DELAY_BETWEEN_BATCHES_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  console.log(`所有批次处理完成。最终总共 ${simplifiedMeanings.length} 个条目保存在文件 ${OUTPUT_FILE} 中。`);
}

processWords();