import json
import os
import sqlite3
import argparse

def read_stardict_db(db_path: str):
    """
    读取 stardict.db 数据库中的元数据
    """
    metadata = {}
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange
            FROM stardict WHERE frq < 100000 AND frq > 0
        """)
        
        for row in cursor.fetchall():
            (word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange) = row
            
            # 转换数据格式
            pos_dict = {}
            if pos:
                for p in pos.split('/'):
                    if p:
                        pos_dict[p] = 1
            
            exchange_dict = {}
            if exchange:
                for item in exchange.split('/'):
                    if ':' in item:
                        key, value = item.split(':', 1)
                        if key and value:
                            exchange_dict[key] = value
            
            # 存储元数据
            metadata[word] = {
                "phonetic": phonetic if phonetic else "",
                "definition": definition.split('\n') if definition else [],
                "translation": translation.split('\n') if translation else [],
                "pos": pos_dict,
                **({"collins": collins} if collins is not None else {}),
                **({"oxford": oxford} if oxford is not None else {}),
                **({"tag": tag.split(' ')} if tag else {}),
                **({"bnc": bnc} if bnc is not None else {}),
                **({"frq": frq} if frq is not None else {}),
                **({"exchange": exchange_dict} if exchange_dict else {})
            }
            
    except Exception as e:
        print(f"读取数据库时出错: {e}")
    finally:
        if conn:
            conn.close()
    
    return metadata

def merge_word_data(freq_threshold=None, output_file=None):
    """
    以JSON文件为主，合并单词数据
    
    Args:
        freq_threshold (int, optional): 筛选 frq 和 bnc 词频的阈值
        output_file (str, optional): 输出文件名
    """
    all_words = {}
    db_file = "stardict.db"
    src_dir = os.path.join("src")  # 修改为从src目录读取
    
    # 首先读取数据库中的元数据
    print("正在读取数据库元数据...")
    metadata = read_stardict_db(db_file)
    
    # 遍历A-Z的JSON文件
    for letter in range(ord('A'), ord('Z') + 1):
        filename = os.path.join(src_dir, f"{chr(letter)}.json")  # 修改文件路径
        if os.path.exists(filename):
            try:
                with open(filename, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    # 处理每个单词条目
                    for entry in data:
                        if 'word' in entry:
                            # 移除单词中的空格
                            word = entry['word'].strip()
                            entry['word'] = word
                            
                            # 如果数据库中有这个单词的元数据，合并进来
                            if word in metadata:
                                # 保留JSON文件中的detail字段
                                detail = entry.get('detail', {})
                                # 更新条目，保留JSON中的数据，补充数据库中的元数据
                                entry.update(metadata[word])
                                # 确保detail字段不被覆盖
                                entry['detail'] = detail
                            
                            # 如果设置了词频阈值，检查词频
                            if freq_threshold is not None:
                                bnc = entry.get('bnc', 10**10)
                                frq = entry.get('frq', 10**10)
                                if bnc <= freq_threshold or frq <= freq_threshold:
                                    all_words[word] = entry
                            else:
                                all_words[word] = entry
                print(f"成功读取并处理 {filename}")
            except Exception as e:
                print(f"处理 {filename} 时出错: {e}")
    
    # 转换为列表并排序
    word_list = list(all_words.values())
    word_list.sort(key=lambda x: x['word'].lower())
    
    # 写入合并后的文件
    try:
        output_file = output_file or "30k.full.json"
        min_output_file = output_file.rsplit('.json', 1)[0] + '.min.json'
        
        print(f"正在写入合并后的数据到: {output_file}")
        # 写入格式化的JSON
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(word_list, f, ensure_ascii=False, indent=2)
            
        # 写入最小化的JSON
        print(f"正在写入最小化数据到: {min_output_file}")
        with open(min_output_file, 'w', encoding='utf-8') as f:
            json.dump(word_list, f, ensure_ascii=False, separators=(',', ':'))
            
        print(f"成功将 {len(word_list)} 个单词写入到 {output_file} 和 {min_output_file}")
    except Exception as e:
        print(f"写入文件时出错: {e}")

if __name__ == "__main__":
    # 设置命令行参数
    parser = argparse.ArgumentParser(description='合并单词数据并进行词频筛选')
    parser.add_argument('--freq', type=int, help='词频阈值（筛选 bnc 和 frq 小于等于该值的单词）')
    parser.add_argument('--output', type=str, help='输出文件名（默认为 30k.full.json）')
    
    args = parser.parse_args()
    merge_word_data(freq_threshold=args.freq, output_file=args.output)