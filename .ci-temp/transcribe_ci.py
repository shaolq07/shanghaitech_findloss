from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
import os
import re

MODEL_NAME = "small"
CACHE_DIR = str(Path(".ci_runtime/fw_model").resolve())
LABELS = ["第1讲", "第2讲", "第3讲", "第32讲", "第33讲"]
PROMPT = "这是一节托福 TOEFL 强化课程。讲解以中文为主，夹杂大量英文单词、英文句子、阅读材料和听力内容。准确保留中英文原话、英文术语、专有名词和题目表述。"


def ts(sec: float) -> str:
    ms = max(0, int(round(sec * 1000)))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def transcribe_one(i: int):
    from faster_whisper import WhisperModel
    src = Path(f"media/lesson_{i+1}.mp4")
    outdir = Path("output")
    outdir.mkdir(exist_ok=True)
    out = outdir / f"TOEFL强化班_{LABELS[i]}.srt"
    model = WhisperModel(
        MODEL_NAME,
        device="cpu",
        compute_type="int8",
        cpu_threads=1,
        num_workers=1,
        download_root=CACHE_DIR,
        local_files_only=True,
    )
    segments, info = model.transcribe(
        str(src),
        language="zh",
        task="transcribe",
        beam_size=3,
        best_of=3,
        temperature=0.0,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 450},
        condition_on_previous_text=True,
        initial_prompt=PROMPT,
        word_timestamps=False,
    )
    count = 0
    last_end = 0.0
    with out.open("w", encoding="utf-8", newline="\n") as f:
        for seg in segments:
            text = re.sub(r"\s+", " ", seg.text).strip()
            if not text:
                continue
            start = float(seg.start)
            if start < last_end - 0.25:
                start = last_end
            end = max(float(seg.end), start + 0.05)
            count += 1
            f.write(f"{count}\n{ts(start)} --> {ts(end)}\n{text}\n\n")
            last_end = end
    return i, str(out), count, getattr(info, "language", None)


def validate():
    files = list(Path("output").glob("*.srt"))
    if len(files) != 5:
        raise RuntimeError(f"Expected 5 SRT files, got {len(files)}")
    tc = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$")
    for p in files:
        blocks = re.split(r"\n\s*\n", p.read_text(encoding="utf-8").strip())
        if len(blocks) < 20:
            raise RuntimeError(f"Too few subtitle blocks in {p}: {len(blocks)}")
        prev_end = -1
        for idx, block in enumerate(blocks, 1):
            lines = block.splitlines()
            if len(lines) < 3 or lines[0].strip() != str(idx):
                raise RuntimeError(f"Bad SRT block {idx} in {p}")
            m = tc.match(lines[1].strip())
            if not m:
                raise RuntimeError(f"Bad timestamp {lines[1]!r} in {p}")
            v = list(map(int, m.groups()))
            start = ((v[0] * 60 + v[1]) * 60 + v[2]) * 1000 + v[3]
            end = ((v[4] * 60 + v[5]) * 60 + v[6]) * 1000 + v[7]
            if not (end > start >= 0 and start >= prev_end - 500):
                raise RuntimeError(f"Non-monotonic timestamp in {p}, block {idx}")
            prev_end = end
        print(f"VALID {p.name}: {len(blocks)} blocks", flush=True)


def main():
    from faster_whisper import WhisperModel
    Path("output").mkdir(exist_ok=True)
    Path(CACHE_DIR).mkdir(parents=True, exist_ok=True)
    print("Downloading/loading Whisper small model once...", flush=True)
    model = WhisperModel(
        MODEL_NAME,
        device="cpu",
        compute_type="int8",
        cpu_threads=2,
        num_workers=1,
        download_root=CACHE_DIR,
    )
    del model
    workers = min(4, os.cpu_count() or 2, 5)
    print(f"Starting {workers} parallel transcription workers", flush=True)
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(transcribe_one, i) for i in range(5)]
        for fut in as_completed(futures):
            i, path, count, language = fut.result()
            print(f"DONE lesson={LABELS[i]} segments={count} language={language} file={path}", flush=True)
    validate()


if __name__ == "__main__":
    main()
