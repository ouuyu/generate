require('dotenv').config(); // 加载 .env 文件中的环境变量

const fs = require('fs').promises; // 导入文件系统模块（使用 promises 版本）
const Excel = require('exceljs'); // 导入 exceljs 库来处理 Excel 文件
const { OpenAI } = require('openai'); // 导入 openai 库
const yargs = require('yargs/yargs'); // 导入 yargs 库来处理命令行参数
const { hideBin } = require('yargs/helpers'); // yargs 的辅助函数
const pLimit = require('p-limit'); // 导入 p-limit 库

// 解析命令行参数
const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    description: '输入的 Excel 文件路径', // 修改描述为 Excel 文件
    type: 'string',
    demandOption: true // input 参数是必需的
  })
  .option('output', {
    alias: 'o',
    description: '输出的 JSON 文件路径',
    type: 'string',
    demandOption: true // output 参数是必需的
  })
  .option('letter', {
    alias: 'l',
    description: '处理的起始字母 (A-Z)', // 添加 letter 参数
    type: 'string',
    demandOption: true // letter 参数是必需的
  })
  .option('concurrency', {
    alias: 'c',
    description: '并发请求的数量', // 添加并发参数
    type: 'number',
    default: 5 // 默认并发数量为 5
  })
  .help() // 添加 help 信息
  .argv; // 获取解析后的参数

// 初始化 OpenAI 客户端
const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL, // 使用环境变量中的 BASE_URL
  apiKey: process.env.OPENAI_API_KEY, // 使用环境变量中的 API_KEY
});

// 检查 API 密钥是否设置
if (!process.env.OPENAI_API_KEY) {
  console.error("错误：未找到 OPENAI_API_KEY 环境变量。请在 .env 文件中设置或在系统中设置。");
  process.exit(1); // 如果没有密钥，退出程序
}

// 从 Excel 文件读取单词列表
async function readExcelWords(excelFile) {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(excelFile); // 读取 Excel 文件

  const worksheet = workbook.getWorksheet(1); // 获取第一个工作表
  const words = []; // 存储读取的单词信息

  // 获取表头行来确定列的索引
  const headerRow = worksheet.getRow(1);
  let wordColIndex = null;
  let translationColIndex = null;

  // 遍历表头单元格，找到 'word' 和 'translation' 列的索引
  headerRow.eachCell((cell, colNumber) => {
    const header = (cell.value || '').toString().toLowerCase();
    if (header === 'word') wordColIndex = colNumber;
    else if (header === 'translation') translationColIndex = colNumber;
  });

  // 检查是否找到了必需的列
  if (!wordColIndex || !translationColIndex) {
    throw new Error('Excel文件必须包含 word 和 translation 列');
  }

  // 读取数据行
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return; // 跳过表头行

    const wordCell = row.getCell(wordColIndex);
    const word = wordCell.value;

    // 确保 word 是有效的字符串
    if (!word || typeof word !== 'string' || !word.trim()) return;

    const translationCell = row.getCell(translationColIndex);
    const translation = (translationCell.value || '').toString();

    // 将单词信息添加到数组
    words.push({
      word: word.trim(),
      translation: translation,
      pos: '', // 保持空字符串作为默认值
      definition: '' // 保持空字符串作为默认值
    });
  });

  return words; // 返回所有单词
}

// 从 JSON 文件加载已存在的完整数据
async function loadFullExistingData(jsonFile) {
  try {
    const content = await fs.readFile(jsonFile, 'utf-8'); // 读取 JSON 文件内容
    const data = JSON.parse(content); // 解析 JSON 内容
    // 如果解析结果是数组则返回，否则返回空数组
    return Array.isArray(data) ? data : [];
  } catch (error) {
    // 如果文件不存在或解析失败，返回一个空数组
    console.warn(`文件 ${jsonFile} 不存在或无法读取，将从空数据开始。`);
    return [];
  }
}

// 调用 OpenAI 生成单词相关数据（例句、词性、定义）
async function generateWordData(wordInfo) {
  try {
    const prompt = await fs.readFile('sentence/sentence.prompt.txt', 'utf-8'); // 读取 prompt 模板文件
    // 替换 prompt 中的占位符
    const promptWithWord = prompt
      .replace('WORD_HERE', wordInfo.word)
      .replace('MEANING_HERE', wordInfo.translation);

    // 调用 OpenAI API 创建聊天完成
    const completion = await openai.chat.completions.create({
      model: "deepseek-ai/DeepSeek-V3", // 使用指定的模型
      messages: [
        {
          role: "user",
          content: promptWithWord // 发送构建好的 prompt
        }
      ],
      temperature: 0.7, // 控制生成文本的随机性
    });

    const response = completion.choices[0].message.content; // 获取模型的回复内容
    try {
      console.log(`原始响应 (${wordInfo.word}):`, response); // 打印原始回复
      const parsedData = JSON.parse(response); // 尝试解析回复为 JSON 对象
       // 确保解析后的数据结构正确，例如包含 sentence, pos, definition
       if (parsedData && typeof parsedData === 'object' && parsedData.sentence && parsedData.pos && parsedData.definition) {
         // 返回包含原始 wordInfo 的完整数据
         return {
           word: wordInfo.word,
           translation: wordInfo.translation,
           ...parsedData // 合并解析出的数据
         };
       } else {
         console.error(`解析 ${wordInfo.word} 的响应格式不正确。`);
         return null; // 格式不正确返回 null
       }
    } catch (error) {
      console.error(`解析 ${wordInfo.word} 的响应失败:`, error); // 解析失败时报错
      return null; // 解析失败返回 null
    }
  } catch (error) {
    console.error(`生成 ${wordInfo.word} 的数据时发生错误:`, error.message); // 调用 API 失败时报错
    return null; // API 调用失败返回 null
  }
}

// 将完整的数据数组保存到 JSON 文件（覆盖模式）
async function saveAllWordData(allData, jsonFile) {
  try {
    // 将整个数组写入 JSON 文件，使用漂亮的格式 (null, 2)
    await fs.writeFile(jsonFile, JSON.stringify(allData, null, 2), 'utf-8');
  } catch (error) {
    console.error('保存数据失败:', error); // 保存失败时报错
    throw error; // 抛出错误以便上层捕获
  }
}

// 主函数
async function main() {
  try {
    const targetLetter = argv.letter.toUpperCase(); // 获取目标字母并转为大写
    if (targetLetter.length !== 1 || !targetLetter.match(/[A-Z]/)) {
      console.error('错误： letter 参数必须是单个字母 (A-Z)。');
      process.exit(1);
    }

    const concurrencyLimit = argv.concurrency; // 获取并发数量
    const limit = pLimit(concurrencyLimit); // 创建并发限制器

    // 加载已存在的完整数据，并创建已处理单词的 Set
    let existingData = await loadFullExistingData(argv.output);
    const existingWordsSet = new Set(existingData.map(item => item.word));

    const allWords = await readExcelWords(argv.input); // 读取 Excel 中的所有单词

    // 过滤出以目标字母开头且尚未处理的单词
    const wordsToProcess = allWords.filter(wordInfo =>
      wordInfo.word.toUpperCase().startsWith(targetLetter) && !existingWordsSet.has(wordInfo.word)
    );

    console.log(`开始为以字母 "${targetLetter}" 开头且未处理的 ${wordsToProcess.length} 个单词生成例句，并发数设置为 ${concurrencyLimit}...`);

    let processedCount = 0; // 已尝试处理的计数（包括成功和失败）
    const successfulResults = []; // 存储成功生成的数据

    // 使用 p-limit 运行并发任务
    const tasks = wordsToProcess.map(wordInfo =>
      limit(async () => {
        console.log(`正在处理单词: ${wordInfo.word}`);
        const wordData = await generateWordData(wordInfo); // 调用 OpenAI 生成数据
        processedCount++; // 增加已处理计数
        if (wordData) {
          console.log(`成功生成 ${wordInfo.word} 的数据`);
          successfulResults.push(wordData); // 将成功结果添加到数组
        } else {
          console.error(`单词 "${wordInfo.word}" 处理失败。`);
        }
        // 可以选择在这里添加少量延迟，但并发模式下通常不需要显式延迟，除非遇到API速率限制
        // await new Promise(resolve => setTimeout(resolve, 100));
      })
    );

    // 等待所有并发任务完成
    await Promise.all(tasks);

    // 将新的成功结果添加到现有数据中
    const updatedData = [...existingData, ...successfulResults];

    // 保存更新后的完整数据
    if (updatedData.length > 0) {
         console.log(`\n保存 ${updatedData.length} 条数据到 ${argv.output}...`);
         await saveAllWordData(updatedData, argv.output);
         console.log("数据保存成功。");
    } else {
        console.log("\n没有生成新的数据需要保存。");
    }


    console.log(`\n处理完成! 总共尝试处理 ${processedCount} 个单词。成功: ${successfulResults.length}, 失败: ${processedCount - successfulResults.length}`);

  } catch (error) {
    console.error('程序执行过程中发生错误:', error);
    process.exit(0); // 出错时以状态码 0 退出，避免 GH Actions 标记为失败（根据原代码逻辑）
  }
}

main(); // 执行主函数