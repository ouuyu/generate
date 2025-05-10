const axios = require('axios');
const readline = require('readline');

// 创建一个 readline 接口以接受用户输入
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 提示用户输入所需信息
function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

// 获取 GitHub API 信息
async function getGitHubConfig() {
  const token = await askQuestion('请输入你的 GitHub 个人访问令牌 (Token): ');
  const owner = await askQuestion('请输入仓库拥有者 (Owner): ');
  const repo = await askQuestion('请输入仓库名称 (Repo): ');
  return { token, owner, repo };
}

// 删除操作逻辑
async function deleteActionsRuns(token, owner, repo) {
  const BASE_URL = `https://api.github.com/repos/${owner}/${repo}/actions/runs`;
  const axiosInstance = axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  // 获取所有运行记录的 ID
  async function getAllRunIds(page = 1) {
    try {
      const response = await axiosInstance.get(`?per_page=100&page=${page}`);
      const runs = response.data.workflow_runs;
      const nextPage = response.headers.link?.includes('rel="next"');
      if (nextPage) {
        return runs.map((run) => run.id).concat(await getAllRunIds(page + 1));
      }
      return runs.map((run) => run.id);
    } catch (error) {
      console.error('获取运行记录失败:', error.response?.data || error.message);
      return [];
    }
  }

  // 删除单个运行记录
  async function deleteRun(runId) {
    try {
      await axiosInstance.delete(`/${runId}`);
      console.log(`成功删除运行记录: ${runId}`);
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`运行记录 ${runId} 不存在，可能已经被删除。`);
      } else {
        console.error(`删除运行记录 ${runId} 失败:`, error.response?.data || error.message);
      }
    }
  }

  // 主流程
  console.log(`开始删除 ${owner}/${repo} 的 Actions 运行记录...`);
  const runIds = await getAllRunIds();

  if (runIds.length === 0) {
    console.log('没有找到任何运行记录。');
    return;
  }

  for (const runId of runIds) {
    await deleteRun(runId);
  }

  console.log('所有运行记录已删除。');
}

// 主函数
async function main() {
  try {
    const { token, owner, repo } = await getGitHubConfig();
    if (!token || !owner || !repo) {
      console.error('输入信息不完整，请重新运行脚本并提供所有必要信息。');
      process.exit(1);
    }
    await deleteActionsRuns(token, owner, repo);
  } catch (error) {
    console.error('脚本运行出错:', error.message);
  } finally {
    rl.close();
  }
}

main();