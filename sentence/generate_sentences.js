require('dotenv').config();

const fs = require('fs').promises;
const Excel = require('exceljs');
const { OpenAI } = require('openai');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    description: '输入的 Excel 文件路径',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    description: '输出的 JSON 文件路径',
    type: 'string',
    demandOption: true
  })
  .option('letter', {
    alias: 'l',
    description: '处理的起始字母 (A-Z)',
    type: 'string',
    demandOption: true
  })
  .option('concurrency', {
    alias: 'c',
    description: '并发请求的数量',
    type: 'number',
    default: 5
  })
  .help()
  .argv;

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.error("错误：未找到 OPENAI_API_KEY 环境变量。请在 .env 文件中设置或在系统中设置。");
  process.exit(1);
}

async function readExcelWords(excelFile) {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(excelFile);

  const worksheet = workbook.getWorksheet(1);
  const words = [];

  const headerRow = worksheet.getRow(1);
  let wordColIndex = null;
  let translationColIndex = null;

  headerRow.eachCell((cell, colNumber) => {
    const header = (cell.value || '').toString().toLowerCase();
    if (header === 'word') wordColIndex = colNumber;
    else if (header === 'translation') translationColIndex = colNumber;
  });

  if (!wordColIndex || !translationColIndex) {
    throw new Error('Excel文件必须包含 word 和 translation 列');
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;

    const wordCell = row.getCell(wordColIndex);
    const word = wordCell.value;

    if (!word || typeof word !== 'string' || !word.trim()) return;

    const translationCell = row.getCell(translationColIndex);
    const translation = (translationCell.value || '').toString();

    words.push({
      word: word.trim(),
      translation: translation,
      pos: '',
      definition: ''
    });
  });

  return words;
}

async function loadFullExistingData(jsonFile) {
  try {
    const content = await fs.readFile(jsonFile, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn(`文件 ${jsonFile} 不存在或无法读取，将从空数据开始。`);
    return [];
  }
}

async function generateWordData(wordInfo) {
  try {
    const prompt = await fs.readFile('sentence/sentence.prompt.txt', 'utf-8');
    const promptWithWord = prompt
      .replace('WORD_HERE', wordInfo.word)
      .replace('MEANING_HERE', wordInfo.translation);

    const completion = await openai.chat.completions.create({
      model: "deepseek-ai/DeepSeek-V3",
      messages: [
        {
          role: "user",
          content: promptWithWord
        }
      ],
      temperature: 0.7,
    });

    const response = completion.choices[0].message.content;
    try {
      console.log(`原始响应 (${wordInfo.word}):`, response);
      const parsedData = JSON.parse(response);
        if (parsedData && typeof parsedData === 'object') {
          return {
            word: wordInfo.word,
            translation: wordInfo.translation,
            ...parsedData
          };
        } else {
          console.error(`解析 ${wordInfo.word} 的响应格式不正确。`);
          return null;
        }
    } catch (error) {
      console.error(`解析 ${wordInfo.word} 的响应失败:`, error);
      return null;
    }
  } catch (error) {
    console.error(`生成 ${wordInfo.word} 的数据时发生错误:`, error.message);
    return null;
  }
}

async function saveAllWordData(allData, jsonFile) {
  try {
    await fs.writeFile(jsonFile, JSON.stringify(allData, null, 2), 'utf-8');
  } catch (error) {
    console.error('保存数据失败:', error);
    throw error;
  }
}

async function processSingleWord(wordInfo) {
    console.log(`正在处理单词: ${wordInfo.word}`);
    const wordData = await generateWordData(wordInfo);
    if (wordData) {
      console.log(`成功生成 ${wordInfo.word} 的数据`);
      return wordData;
    } else {
      console.error(`单词 "${wordInfo.word}" 处理失败。`);
      return null;
    }
}


async function main() {
  try {
    const targetLetter = argv.letter.toUpperCase();
    if (targetLetter.length !== 1 || !targetLetter.match(/[A-Z]/)) {
      console.error('错误： letter 参数必须是单个字母 (A-Z)。');
      process.exit(1);
    }

    const concurrencyLimit = argv.concurrency;
    if (concurrencyLimit <= 0) {
      console.error('错误：并发数量必须大于 0。');
      process.exit(1);
    }


    let existingData = await loadFullExistingData(argv.output);
    const existingWordsSet = new Set(existingData.map(item => item.word));

    const allWords = await readExcelWords(argv.input);

    const wordsToProcess = allWords.filter(wordInfo =>
      wordInfo.word.toUpperCase().startsWith(targetLetter) && !existingWordsSet.has(wordInfo.word)
    );

    console.log(`开始为以字母 "${targetLetter}" 开头且未处理的 ${wordsToProcess.length} 个单词生成例句，并发数设置为 ${concurrencyLimit}...`);

    const totalWordsToProcess = wordsToProcess.length;
    let processedCount = 0;
    const runningPromises = [];
    const successfulResults = [];

    while (wordsToProcess.length > 0 || runningPromises.length > 0) {
        if (runningPromises.length < concurrencyLimit && wordsToProcess.length > 0) {
            const wordInfo = wordsToProcess.shift();

            const promise = processSingleWord(wordInfo)
                .then(result => {
                    processedCount++;
                    if (result) {
                        successfulResults.push(result);
                    }
                    return result;
                })
                .catch(error => {
                    processedCount++;
                    console.error(`处理单词 ${wordInfo.word} 时发生未捕获错误:`, error);
                    return null;
                })
                .finally(() => {
                    const index = runningPromises.indexOf(promise);
                    if (index > -1) {
                        runningPromises.splice(index, 1);
                    }
                });

            runningPromises.push(promise);

        } else if (runningPromises.length > 0) {
            await Promise.race(runningPromises);
        } else {
              break;
        }
    }

    const updatedData = [...existingData, ...successfulResults];

    if (updatedData.length > 0) {
          console.log(`\n保存 ${updatedData.length} 条数据到 ${argv.output}...`);
          await saveAllWordData(updatedData, argv.output);
          console.log("数据保存成功。");
    } else {
        console.log("\n没有生成新的数据需要保存。");
    }

    const failedCount = totalWordsToProcess - successfulResults.length;
    console.log(`\n处理完成! 总共尝试处理 ${totalWordsToProcess} 个单词。成功: ${successfulResults.length}, 失败: ${failedCount}`);

  } catch (error) {
    console.error('程序执行过程中发生错误:', error);
    process.exit(0);
  }
}

main();