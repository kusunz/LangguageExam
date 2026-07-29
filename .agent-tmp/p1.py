import sys

with open(r"G:\japanesePractice\server\server.js", "rb") as f:
    raw = f.read()
content = raw.decode("utf-8")

START_MARKER = "      if (wrongQuestions.length > 0) {\r\n        const analysisConfig = getDetailedGradeAnalysisRunConfig({"
END_OF_IF = "              .filter(Boolean);\r\n          }\r\n        });\r\n      }"

start_idx = content.find(START_MARKER)
if start_idx == -1:
    print("ERROR: START_MARKER not found"); sys.exit(1)

end_idx = content.find(END_OF_IF, start_idx + len(START_MARKER))
if end_idx == -1:
    print("ERROR: END_OF_IF not found"); sys.exit(1)
end_idx += len(END_OF_IF)
print(f"Replacing block chars {start_idx}-{end_idx}")

