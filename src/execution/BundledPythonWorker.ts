/** Minimal isolated JSON-RPC worker bundled into main.js; provider/model execution remains explicit. */
export const BUNDLED_PYTHON_WORKER = String.raw`
import json, sys

def respond(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()

for line in sys.stdin:
    try:
        request = json.loads(line)
        rid = request.get('id')
        if request.get('jsonrpc') != '2.0' or request.get('method') != 'command_center.execute':
            respond({'jsonrpc':'2.0','id':rid,'error':{'code':-32601,'message':'Unsupported JSON-RPC method.'}})
            continue
        params = request.get('params') or {}
        task_type = params.get('taskType')
        if task_type == 'embeddings':
            respond({'jsonrpc':'2.0','id':rid,'error':{'code':-32001,'message':'No local Python embedding backend is configured.'}})
        else:
            respond({'jsonrpc':'2.0','id':rid,'error':{'code':-32002,'message':'No local Python agent backend is configured.'}})
    except Exception:
        respond({'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Malformed worker request.'}})
`;
