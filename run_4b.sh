cd ~/事务/研究jev
export PYTHONPATH=tools:pylibs
python3 - <<'PY'
import os
os.chdir(os.path.expanduser('~/事务/研究jev'))
import bench_llm
bench_llm.MODELS=[m for m in bench_llm.MODELS if '4B' in m]
bench_llm.main()
PY
