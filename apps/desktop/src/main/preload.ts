/**
 * preload（04 §3.2）：contextBridge 暴露最小帧通道 API——renderer 不接触 Node 原生模块，
 * 只见字符串帧与生命周期通知（06 §6.2 IpcBridgeTransport = 虚拟 stdio，业务帧端到端透传）。
 */
import { contextBridge, ipcRenderer } from "electron";

export interface RaincodeBridgeApi {
  /** 发送一帧（JSONL 行，不含换行符）。 */
  sendFrame(line: string): void;
  /** 订阅 agent → renderer 帧（JSONL 行）。返回退订函数。 */
  onFrame(listener: (line: string) => void): () => void;
  /** 订阅 agent 子进程退出（守护重启与离线态呈现依据，NFR-7）。 */
  onAgentExit(listener: (info: { code: number | null; signal: string | null; intentional: boolean }) => void): () => void;
  /** 原生目录选择：工作区切换器。 */
  pickWorkspace(): Promise<string | null>;
  /** 运行形态（dev | packaged）。 */
  meta(): Promise<{ mode: string }>;
}

const api: RaincodeBridgeApi = {
  sendFrame: (line) => {
    ipcRenderer.send("agent:frame:send", line);
  },
  onFrame: (listener) => {
    const wrapped = (_event: unknown, line: string): void => listener(line);
    ipcRenderer.on("agent:frame", wrapped);
    return () => {
      ipcRenderer.removeListener("agent:frame", wrapped);
    };
  },
  onAgentExit: (listener) => {
    const wrapped = (_event: unknown, info: { code: number | null; signal: string | null; intentional: boolean }): void =>
      listener(info);
    ipcRenderer.on("agent:exit", wrapped);
    return () => {
      ipcRenderer.removeListener("agent:exit", wrapped);
    };
  },
  pickWorkspace: () => ipcRenderer.invoke("agent:pick-workspace"),
  meta: () => ipcRenderer.invoke("agent:meta"),
};

contextBridge.exposeInMainWorld("raincode", api);
