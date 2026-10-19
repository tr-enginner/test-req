//////////////////////////////////////////////////
//                 使用方法                     //
//////////////////////////////////////////////////
//1.  在driver的stdafx.h中添加：                //
//    #include "vttDevice.h"                    //
//                                              //
//2. 在MainProc VTT_INIT消息处理中添加          //
//    vtt.GetFunctionPointers(dwParam, pData);  //
//                                              //  
//3. 在stdafx.cpp中添加：                       //
//      struct VTTFUNCS vtt;                    //
//                                              //  
//4. 如果本模块需要同一项目中多次加载：         //
//   需在MainProc函数首行加入如下代码：         //
//     vtt.ConfirmDevID(pData);                 //  
//                                              //  
//////////////////////////////////////////////////
//  注: 本文件适用于VTest2.80以后的版本         //
//////////////////////////////////////////////////
#define _AFXDLL


#ifndef _VTTDEVICE
#define _VTTDEVICE

#include <afxtempl.h>

#ifndef VTTTYPE
#define VTTTPYE

#pragma message("VTTDEVIDE") 

#define vttDEVMASK  0x00000000
#define vttCPUMASK  0x10000000
#define vttPLGMASK  0x20000000
#define vttPERMASK  0x40000000
#define vttERRORID  0xFFFFFFFF

#define vttRES      DWORD
#define vttTIMER    DWORD
#define vttPINID    DWORD 
#define vttDEVID    DWORD   //设备ID
#define vttCPUID    DWORD   //CPUID
#define INVALID_DEVID   (-1)   //非法设备ID
#define VHARDENV_DEVID  (-2)   //vhardenv内部使用设备ID

#define EX_DEVID_INDEX  (900)  //900~999，外部系统注册的设备ID范围

#define TYPE_SYMBOL WORD
#define LONGADR		UINT64
#define TADDR unsigned __int64
#define uint64_t unsigned __int64
#define int64_t signed __int64

typedef enum {
	VTTREAD,
	VTTWRITE,
	VTTREADWRITE,
} VTTACCESS;

typedef enum tagvttTIMER_TYPE {  //时钟类型
	CYCLE_TIMER,                //循环时钟
	ONCE_TIMER                  //一次时钟
}vttTIMER_TYPE;

typedef struct tagTCHIP_HEADER {
	vttDEVID    uID;            //设备ID
	int         nSize;          //传递在MainProc中void*指向结构体的大小
	int         nPortCount;     //端口数量
	void*       pUser;
}TCHIP_HEADER;

typedef enum tagEPORT_TYPE {
	IOPORT,                     //一般的I/O端口
	VIOPORT,                    //虚拟I/O端口
	IOPIN,                      //一般的PIN;
}EPORT_TYPE;

typedef struct tagTPORT {        //定义端口
	vttPINID      iID;          //端口内部标识;表示:该端口是该芯片的第几个端口
	char          strName[52];  //端口名称
	EPORT_TYPE    eType;        //端口类型
}vttPORT, *vttPORTLIST;

typedef struct tag_cpu_info {
	char chip_name[64];
	char arch_name[64];
	int exram_type;
	int bytes_per_word;
	int is_big_endian;
}cpu_info;

typedef enum tagvttMESSAGE {     //定义消息
	VTT_QSIZE,                  //查询数据大小
	VTT_INIT,                   //初始化
	VTT_QPORTS,                 //取得端口数组
	VTT_QPROPERTY,              //获得属性
	VTT_QMENU,                  //获得菜单信息
	VTT_SETPROPERTY,            //设置属性
	VTT_RESET,                  //复位
	VTT_TRIGGERMENU,            //触发菜单
	VTT_READ,                   //CPU读端口
	VTT_WRITE,                  //CPU写端口
	VTT_PINCONNECT,             //引脚连接
	VTT_VWBYTES,                //字节流写
	VTT_CLOCK,                  //时钟触发
	VTT_REFRESH,                //刷新显示
	VTT_MESSAGE,                //自定义消息
	VTT_SAVE,                   //保存芯片状态
	VTT_LOAD,                   //装入芯片状态
	VTT_TERMINATE,              //终止
	//--------------------------v2.80 add----------------------------
	VTT_MEMREAD,
	VTT_MEMWRITE,
	VTT_PCEXECUTE,
	VTT_SYNC,

}vttMESSAGE;

typedef struct {                 //VTT_WRITE消息时使用的参数
	vttPINID    vttPinID;
	DWORD       dwValue;
}vttParamWrite;

typedef struct {                 //VTT_VWBYTES消息时使用的参数
	vttPINID    vttPinID;
	int         nSize;
	PBYTE       pByte;
}vttParamVWBytes;

typedef struct {                 //VTT_PINCONNECT消息时使用的参数
	vttPINID    nPinID;
	DWORD       dwValue;
}vttParamPinConnect;

typedef struct {                 //VTT_MEMREAD/MEMWRITE消息时使用的参数
	DWORD dwAddress;
	DWORD dwLength;
	DWORD dwMemType;
}vttParamMemoryEvent;

class __declspec(dllexport) CMemoryMap {
public:
	virtual BYTE&   operator[](UINT64 address) = 0;
	virtual PBYTE   operator+(UINT64 address) = 0;
	virtual unsigned __int64 GetMaxAddress() = 0;
	virtual DWORD GetType() = 0;    //获得内存类型
	virtual DWORD GetWidth() = 0;   //获得内存的字节宽度
	virtual BOOL GetEndian() = 0;   //获得内存对齐方式,TRUE表示Big_Endian 
};

typedef struct TExecTraceInfo {
	UINT64      u64tick;            //时间记录
	DWORD       dwAddressJmp;       //记录跳转前最后一个地址
	DWORD       dwAddressEntry;     //记录跳转后的首地址   
}VTTExeTraceInfo;

enum CoverType {
	ct_UNKNOWN = 0,
	ct_NOTEXCUTE = 1,    //语句未执行
	ct_HASEXCUTE = 2,    //非分支语句已执行
	ct_NOTFULLEXCUTE = 3,
	ct_JMPONLY = 4,    //分支语句跳转分支执行
	ct_JMPNEVER = 5,    //分支语句顺序分支执行
	ct_FULLEXCUTE = 6,    //分支语句完全执行
	ct_UNSURE = 7,
};

//回调函数定义
typedef vttRES(WINAPI *vttMAINPROC)(vttMESSAGE  Msg, void * pData, DWORD dwParam);
typedef void(*VTTSYNCCALLBACK)();
typedef DWORD(*VTTPCCALLBACK)(DWORD dwPc);
typedef void(*VTTMEMORYCALLBACK)(DWORD dwAddress, DWORD dwLentgh, DWORD dwMemType, VTTACCESS vttAccess);
typedef void(*VTTVPORTCALLBACK)(vttDEVID idTargetDev, vttPINID idTargetPin, PBYTE pByte, WORD nSize);
typedef void(*VTTPINCALLBACK)(vttDEVID idTargetDev, vttPINID idTargetPin, DWORD nSize);
typedef void(*VTTTIMERCALLBACK)();

typedef struct tag_swix_ui_api {
	void(*AddLog)(int ntype, const char *fmt, ...);
	void(*ClearLog)(int ntype);

	char strDisLibParam[MAX_PATH];
	char strPluginList[1024];
}swixui;

typedef enum t_vtest_pstat_t {
	ProjectEmpty,
	ProjectLoaded,
	ProjectBuilding,
	ProjectCreating,
	ProjectDebugStopped,
	ProjectDebugRunning,
	ProjectDebugSetpOver,
	ProjectDebugSetpOverIns,
	ProjectClosing,
} vtest_pstat_t;

typedef struct t_vext_func_t {
	void (WINAPI* OnOpenDoc)(const char* strPath);
	void (WINAPI* OnSendMsg)(const char* name, DWORD param, void* data);
	int  (WINAPI* OnGetProjStat)();
	void (WINAPI* OnAddLog)(int which, const char* buf);
	void (WINAPI* OnClearLog)(int which);
	void (WINAPI* OnRefresh)();
	void (WINAPI* OnGotoLine)(DWORD address, bool isdis);
	void (WINAPI* OnExit)();

	void (WINAPI* AfterRun)();
	void (WINAPI* AfterStop)();
	void (WINAPI* AfterStartDebug)();
	void (WINAPI* AfterStopDebug)();
	void (WINAPI* AfterStepInto)();
	void (WINAPI* AfterStepOver)();
	void (WINAPI* AfterStepIntoIns)(DWORD pc);
	void (WINAPI* AfterStepOverIns)(DWORD pc);
	void (WINAPI* AfterOpenProj)(const char* path);
	void (WINAPI* AfterCloseProj)();

	void (WINAPI* OnRun)();
	void (WINAPI* OnStop)();
	void* (WINAPI* OnStartDebug)();
	void (WINAPI* OnStopDebug)();
	DWORD(WINAPI* OnStepInto)();
	DWORD(WINAPI* OnStepOver)();
	DWORD(WINAPI* OnStepIntoIns)();
	DWORD(WINAPI* OnStepOverIns)();
	void (WINAPI* OnOpenProj)(const char* path);
	void (WINAPI* OnCloseProj)();

	t_vext_func_t()
	{
		AfterOpenProj = NULL;
		AfterCloseProj = NULL;
		OnGetProjStat = NULL;

		OnAddLog = NULL;
		OnClearLog = NULL;

		OnRefresh = NULL;
		OnSendMsg = NULL;

		OnOpenDoc = NULL;
		OnGotoLine = NULL;

		OnExit = NULL;

		OnStepInto = NULL;
		OnStepOver = NULL;

		OnStepIntoIns = NULL;
		OnStepOverIns = NULL;

		OnStartDebug = NULL;
		OnStopDebug = NULL;

		OnRun = NULL;
		OnStop = NULL;

		AfterStepInto = NULL;
		AfterStepOver = NULL;

		AfterStepIntoIns = NULL;
		AfterStepOverIns = NULL;

		AfterStartDebug = NULL;
		AfterStopDebug = NULL;

		AfterRun = NULL;
		AfterStop = NULL;
	}
} vext_func_t;

typedef enum t_vremote_type_t {
	VREMOTE_TYPE_REQ,
	VREMOTE_TYPE_REP,
	VREMOTE_TYPE_SET,
	VREMOTE_TYPE_DAT,
	VREMOTE_TYPE_ERR,
} vremote_type_t;

typedef enum t_vremote_cmd_t {
	VREMOTE_EMPTY,
	VREMOTE_OPEN_PROJECT,
	VREMOTE_CLOSE_PROJECT,
	VREMOTE_GET_PROJECT_PATH,
	VREMOTE_OPEN_DOCUMENT,
	VREMOTE_SEND_MESSAGE,
	VREMOTE_RUN,
	VREMOTE_STOP,
	VREMOTE_RESET,
	VREMOTE_START_DEBUG,
	VREMOTE_STOP_DEBUG,
	VREMOTE_GET_PROJECT_STATE,
	VREMOTE_STEP_INTO,
	VREMOTE_STEP_OVER,
	VREMOTE_STEP_INTO_INS,
	VREMOTE_STEP_OVER_INS,
	VREMOTE_ADD_LOG,
	VREMOTE_CLEAR_LOG,
	VREMOTE_REFRESH,
	VREMOTE_GOTO_LINE,
	VREMOTE_EXIT,
} vremote_cmd_t;

typedef union t_vremote_para_t {
	int val;
	unsigned int uval;
} vremote_para_t;

typedef struct t_vremote_msg_t {
	vremote_type_t type;
	vremote_cmd_t cmd;
	vremote_para_t para1;
	vremote_para_t para2;
	vremote_para_t para3;
	vremote_para_t para4;
	char buf;
} vremote_msg_t;

#endif

extern "C" {
	//引脚电平触发
	typedef void    (WINAPI* tPinConnect)(vttDEVID vttDevID, vttPINID nPinID, DWORD dwValue);

	//虚拟端口操作
	typedef BOOL    (WINAPI* tWriteVPort)(vttDEVID vttDevID, vttPINID vttPinID, PBYTE pByte, int nSize);

	//时间管理
	typedef double  (WINAPI* tGetCpuFre)();
	typedef INT64   (WINAPI* tGetRunTick)();
	typedef BOOL    (WINAPI* tCreateTimerByTick)(vttDEVID vttDevID, vttPINID pinID, vttTIMER_TYPE vttTimerType, UINT64 uTick);
	typedef BOOL    (WINAPI* tDeleteTimer)(vttDEVID vttDevID, vttPINID pinID);

	//界面管理
	typedef void    (WINAPI* tAddLog)(const char * pszFormat, ...);  //添加日志
	typedef void    (WINAPI* tClearLog)();                          //清除日志
	typedef void    (WINAPI* tRefreshWindows)();

	//配置文件操作
	typedef void    (WINAPI* tSaveState)(LPCTSTR strPath);          //存调试状态到指定路径
	typedef void    (WINAPI* tLoadState)(LPCTSTR strPath);          //从指定路径读入调试状态
	typedef void    (WINAPI* tSetDevProperty)(vttDEVID devID, LPCTSTR strParam);

	//运行控制
	typedef void    (WINAPI* tStartDebug)();                        //启动调试器
	typedef void    (WINAPI* tStopDebug)();                         //停止调试器
	typedef void    (WINAPI* tResetCpu)(LPCTSTR strParam);          //重置CPU
	typedef void    (WINAPI* tResetDebug)();                        //重置虚拟机
	typedef int     (WINAPI* tIsCpuStopped)();                      //V1.03 Add
	typedef void    (WINAPI* tFlushCode)(DWORD addr);               //V1.06 Add, 直接调用CPU的cpudll_FlushCode
	typedef LPCTSTR (WINAPI* tGetPrjPath)();

	//存储器控制
	typedef BYTE    (WINAPI* tReadByte)(unsigned __int64 dwAddress, DWORD dwMemType);    //读一个字节,地址是字节地址
	typedef void    (WINAPI* tWriteByte)(unsigned __int64 dwAddress, DWORD dwMemType, BYTE byte);//写一个字节,地址是字节地址
																								 //以下函数中使用的是逻辑地址，其中结束地址包含边界
	typedef DWORD   (WINAPI* tReadDWORD)(DWORD dwAddress, DWORD dwMemType);             //读一个DWORD , V1.08 add, 地址是逻辑地址
	typedef void    (WINAPI* tWriteDWORD)(DWORD dwAddress, DWORD dwMemType, DWORD dw);   //写一个DWORD, V1.08 add, 地址是逻辑地址
																						 //在内存地址上设置回调函数，多了连接方式参数
	typedef BOOL    (WINAPI* tSetWatchOnMemoryM)(vttDEVID vttDevID, DWORD dwBeginAddr, DWORD dwEndAddr, DWORD dwMemType, VTTACCESS vtAccess);
	typedef BOOL    (WINAPI* tUnSetWatchOnMemoryM)(vttDEVID vttDevID, DWORD dwBeginAddr, DWORD dwEndAddr, DWORD dwMemType, VTTACCESS vtAccess);

	typedef BOOL    (WINAPI* tSetWatchOnMemory)(DWORD dwBeginAddr, DWORD dwEndAddr, DWORD dwMemType, VTTACCESS vtAccess, VTTMEMORYCALLBACK vttCallBack);
	typedef BOOL    (WINAPI* tUnSetWatchOnMemory)(DWORD dwBeginAddr, DWORD dwEndAddr, DWORD dwMemType, VTTACCESS vtAccess, VTTMEMORYCALLBACK vttCallBack);
	
	//指令执行回调
	typedef void    (WINAPI* tSetWatchOnPc)(vttDEVID vttDevID, DWORD dwPc);
	typedef void    (WINAPI* tUnSetWatchOnPc)(vttDEVID vttDevID, DWORD dwPc);

	//覆盖率文件控制
	typedef void    (WINAPI* tOutCoxFile)(LPCTSTR strFileName);
	typedef void    (WINAPI* tOutMCDCCov)(LPCTSTR strFileName);

	typedef void    (WINAPI* tClearCov)();

	//处理器端接口
	typedef DWORD   (WINAPI* tGetCurPC)();
	typedef DWORD   (WINAPI* tGetRegValue)(DWORD dwWhich);
	typedef void    (WINAPI* tSetRegValue)(DWORD dwWhich, DWORD dwValue);
	typedef void    (WINAPI* tGetRegPtrValue)(DWORD dwWhich, void* pValue);
	typedef void    (WINAPI* tSetRegPtrValue)(DWORD dwWhich, void* pValue);
	typedef int	    (WINAPI* tGetRegValueEx)(DWORD dwWhich, DWORD dwLength, void* pValue);
	typedef int	    (WINAPI* tSetRegValueEx)(DWORD dwWhich, DWORD dwLength, void* pValue);

	//异步函数 用于在其他线程中调用，注册安全回调函数
	typedef void    (WINAPI* tRegSyncCallBack)(vttDEVID vttDevID);

	//表达式相关函数
	typedef void    (WINAPI* tGetExpVal)(LPCTSTR sExp, LPTSTR sVal);
	typedef void    (WINAPI* tGetExpAddr)(LPCTSTR sExp, LPTSTR sAddr);
	typedef BOOL    (WINAPI* tSetSymbolValue)(LPCTSTR sSym, LPCTSTR sVal);

	//模拟器内部控制接口
	typedef DWORD   (WINAPI* tCpuIn)(DWORD dwPort);                     //已废弃
	typedef void    (WINAPI* tCpuOut)(DWORD dwPort, DWORD dwValue);      //已废弃
	typedef void    (WINAPI* tClockSystem)(int wOpTick);
	typedef DWORD*  (WINAPI* tGetRunToTick)();
	typedef int     (WINAPI* tGetFunctionID)(unsigned __int64 udwAddr);
	typedef int     (WINAPI* tGetFunctionInfo)(unsigned __int64 udwAddr, unsigned __int64* pFunc, DWORD *pLen);
	typedef void	(WINAPI* tGetFuncNameByAddr)(DWORD dAddr, char* pFuncName);	
	typedef int     (WINAPI* tGetCodeSection)(unsigned __int64* udwAddr, DWORD* len, int maxSize);
	typedef void    (WINAPI* tGetStartAddress)(DWORD &dwBase, DWORD &dwOffset);
	typedef void    (WINAPI* tWatchExeAt)(DWORD dwPc);
	typedef void    (WINAPI* tOnSyncEvent)(void);
	typedef void    (WINAPI* tLogInterruptTriger)(LPCTSTR lpIntInfo);
	typedef void    (WINAPI* tOnDataWatchRead)(DWORD dwAddress, int length, DWORD dwMemType);
	typedef void    (WINAPI* tOnDataWatchWrite)(DWORD dwAddress, int length, DWORD dwMemType);

	typedef void 	(WINAPI* tDisAssemble)(DWORD &dwAddress, LPSTR reString);


	//其他接口
	typedef int     (WINAPI* tGetDevID)(LPCTSTR sDevName);                                                  //获取设备号
	typedef DWORD   (WINAPI* tGetRegID)(LPCTSTR sRegName);                                                  //获取RegID
	typedef int     (WINAPI* tPinConnectUltra)(vttDEVID vttDevID, LPCTSTR sPinName, DWORD dwValue);         //设置任意引脚
	typedef int     (WINAPI* tWriteVPortUltra)(vttDEVID vttDevID, LPCTSTR sPinName, BYTE* pData, int nSize);//写任意虚端口
	typedef vttRES  (WINAPI* tSendMsg)(vttDEVID dwID, DWORD dwPara, void* pBuffer);                         //发送消息

	//多核
	typedef DWORD   (WINAPI* tGetActiveCoreID)(void);           //获得活动核ID
	typedef BOOL    (WINAPI* tSetActiveCoreID)(DWORD nID);      //获得活动核ID

	//时间点
	typedef void    (WINAPI* tSetStartTimeAddr)(DWORD dwAddr);
	typedef void    (WINAPI* tSetEndTimeAddr)(DWORD dwAddr);
	typedef void    (WINAPI* tClearAllTimeCounter)();
	typedef void    (WINAPI* tOutCountFile)(LPCTSTR strFileName);


	struct VTTFUNCS {
	public:
		//对外接口(38)
		tPinConnect               _PinConnect;
		tWriteVPort               _WriteVPort;
		tGetCpuFre                GetCpuFre;
		tGetRunTick               GetRunTick;
		tCreateTimerByTick        _CreateTimerByTick;
		tDeleteTimer              _DeleteTimer;
		tAddLog                   AddLog;
		tClearLog                 ClearLog;
		tRefreshWindows           RefreshWindows;
		tSaveState                SaveState;
		tLoadState                LoadState;
		tSetDevProperty           _SetDevProperty;
		tStartDebug               StartDebug;
		tStopDebug                StopDebug;
		tResetCpu                 ResetCpu;
		tResetDebug               ResetDebug;
		tIsCpuStopped             IsCpuStopped;
		tFlushCode                FlushCode;
		tGetPrjPath               GetPrjPath;
		tReadByte                 ReadByte;
		tWriteByte                WriteByte;
		tReadDWORD                ReadDWORD;
		tWriteDWORD               WriteDWORD;
		tSetWatchOnMemoryM       _SetWatchOnMemory;
		tUnSetWatchOnMemoryM     _UnSetWatchOnMemory;
		tSetWatchOnMemory        SetWatchOnMemory;
		tUnSetWatchOnMemory      UnSetWatchOnMemory;
		tSetWatchOnPc            _SetWatchOnPc;
		tUnSetWatchOnPc          _UnSetWatchOnPc;
		tOutCoxFile              OutCoxFile;
		tOutMCDCCov              OutMCDCCov;
		tClearCov                ClearCov;
		tGetCurPC                GetCurPC;
		tGetRegValue             GetRegValue;
		tSetRegValue             SetRegValue;
		tGetRegPtrValue          GetRegPtrValue;
		tSetRegPtrValue          SetRegPtrValue;
		tRegSyncCallBack         _RegSyncCallBack;
		tGetExpAddr              GetExpAddr;
		tGetExpVal               GetExpVal;
		tSetSymbolValue          SetSymbolValue;
		tDisAssemble             DisAssemble;
		//内部接口(15)
		tCpuIn                   CpuIn;
		tCpuOut                  CpuOut;
		tClockSystem             ClockSystem;
		tGetRunToTick            GetRunToTick;
		tGetFunctionID           GetFunctionID;
		tGetFunctionInfo         GetFunctionInfo;
		tGetFuncNameByAddr       GetFuncNameByAddr;
		tGetCodeSection          GetCodeSection;
		tWatchExeAt              WatchExeAt;
		tOnSyncEvent             OnSyncEvent;
		tGetStartAddress         GetStartAddress;
		tLogInterruptTriger      LogInterruptTriger;
		tOnDataWatchRead         OnDataWatchRead;
		tOnDataWatchWrite        OnDataWatchWrite;

		//特殊接口(5)
		tGetRegID                GetRegID;
		tGetDevID                GetDevID;
		tPinConnectUltra         PinConnectUltra;
		tWriteVPortUltra         WriteVportUltra;
		tSendMsg                 SendMsg;

		//多核(2)
		tGetActiveCoreID	     GetActiveCoreID;
		tSetActiveCoreID         SetActiveCoreID;

		//时间点
		tSetStartTimeAddr        SetStartTimeAddr;
		tSetEndTimeAddr          SetEndTimeAddr;
		tClearAllTimeCounter     ClearAllTimeCounter;
		tOutCountFile            OutCountFile;
		
	public:
		vttDEVID m_devid;
		TCHIP_HEADER*  m_pHeader;
		vttDEVID DevID(){return m_devid;};
		void*    GetUserPtr() {
			if (m_pHeader) return m_pHeader->pUser;
			else return NULL;
		};
		void     SetUserPtr(void* pUser) { if (m_pHeader) m_pHeader->pUser = pUser; };
		void     ConfirmDevID(void* pHeader){
			m_pHeader = (TCHIP_HEADER*)pHeader; 
			if (m_pHeader) m_devid = m_pHeader->uID;
		};
		//非导出函数(2)
		double WINAPI GetRunTime(){
			if (!GetRunTick || !GetCpuFre)
				return -1;
			double dTime;
			dTime = (INT64)(GetRunTick()) * 1.0;
			dTime /= GetCpuFre();
			dTime /= 1E6;
			return dTime;
		}
		BOOL WINAPI CreateTimer(vttPINID pinID, vttTIMER_TYPE vttTimerType, double dLapse){
			if (!GetCpuFre)
				return FALSE;
			UINT64 uTick;
			uTick = (UINT64)(dLapse * 1E6 * GetCpuFre());
			return CreateTimerByTick(pinID, vttTimerType, uTick);
		}
		void WINAPI OutCovFile(LPCTSTR strFileName){
			if (OutCoxFile)
				OutCoxFile(strFileName);
		}
		void PinConnect(vttPINID nPinID, DWORD dwValue){
			_PinConnect(m_devid, nPinID, dwValue);
		}
		BOOL WriteVPort(vttPINID vttPinID, PBYTE pByte, int nSize){
			return _WriteVPort(m_devid, vttPinID, pByte, nSize);
		}
		BOOL CreateTimerByTick(vttPINID pinID, vttTIMER_TYPE vttTimerType, UINT64 uTick){
			return _CreateTimerByTick(m_devid, pinID, vttTimerType, uTick);
		}
		BOOL DeleteTimer(vttPINID pinID){
			return _DeleteTimer(m_devid, pinID);
		}
		void SetDevProperty(LPCTSTR strParam){
			_SetDevProperty(m_devid, strParam);
		}
		BOOL SetWatchOnMemoryM(DWORD dwBeginAddr, DWORD dwEndAddr, DWORD dwMemType, VTTACCESS vtAccess){
			return _SetWatchOnMemory(m_devid, dwBeginAddr, dwEndAddr, dwMemType, vtAccess);
		}
		BOOL UnSetWatchOnMemoryM(DWORD dwBeginAddr, DWORD dwEndAddr, DWORD dwMemType, VTTACCESS vtAccess){
			return _UnSetWatchOnMemory(m_devid, dwBeginAddr, dwEndAddr, dwMemType, vtAccess);
		}
		void SetWatchOnPc(DWORD dwPc){
			_SetWatchOnPc(m_devid, dwPc);
		}
		void UnSetWatchOnPc(DWORD dwPc){
			_UnSetWatchOnPc(m_devid, dwPc);
		}
		void RegSyncCallBack(){
			_RegSyncCallBack(m_devid);
		}		
		
	public:
		VTTFUNCS() { Clear(); };
		~VTTFUNCS() { Clear(); };
		void Clear() {
			m_devid = -1;
			m_pHeader = NULL;
			
			//对外接口(38)
			_PinConnect = NULL;
			_WriteVPort = NULL;
			GetCpuFre = NULL;
			GetRunTick = NULL;
			_CreateTimerByTick = NULL;
			_DeleteTimer = NULL;
			AddLog = NULL;
			ClearLog = NULL;
			RefreshWindows = NULL;
			SaveState = NULL;
			LoadState = NULL;
			_SetDevProperty = NULL;
			StartDebug = NULL;
			StopDebug = NULL;
			ResetCpu = NULL;
			ResetDebug = NULL;
			IsCpuStopped = NULL;
			FlushCode = NULL;
			GetPrjPath = NULL;
			ReadByte = NULL;
			WriteByte = NULL;
			ReadDWORD = NULL;
			WriteDWORD = NULL;
			_SetWatchOnMemory = NULL;
			_UnSetWatchOnMemory = NULL;
			SetWatchOnMemory = NULL;
			UnSetWatchOnMemory = NULL;
			_SetWatchOnPc = NULL;
			_UnSetWatchOnPc = NULL;
			OutCoxFile = NULL;
			OutMCDCCov = NULL;
			ClearCov = NULL;
			GetCurPC = NULL;
			GetRegValue = NULL;
			SetRegValue = NULL;
			GetRegPtrValue = NULL;
			SetRegPtrValue = NULL;
			_RegSyncCallBack = NULL;
			GetExpAddr = NULL;
			GetExpVal = NULL;
			SetSymbolValue = NULL;
			DisAssemble = NULL;
			
			//内部接口(15)
			CpuIn = NULL;
			CpuOut = NULL;
			ClockSystem = NULL;
			GetRunToTick = NULL;
			GetFunctionID = NULL;
			GetFunctionInfo = NULL;
			GetFuncNameByAddr = NULL;
			GetCodeSection = NULL;	
			WatchExeAt = NULL;
			OnSyncEvent = NULL;
			GetStartAddress = NULL;
			LogInterruptTriger = NULL;
			OnDataWatchRead = NULL;
			OnDataWatchWrite = NULL;
			
			//特殊接口(5)
			GetRegID = NULL;
			GetDevID = NULL;
			PinConnectUltra = NULL;
			WriteVportUltra = NULL;
			SendMsg = NULL;

			//多核(2)
			GetActiveCoreID = NULL;
			SetActiveCoreID = NULL;	

			//时间点
			SetStartTimeAddr      = NULL;
			SetEndTimeAddr        = NULL;
			ClearAllTimeCounter   = NULL;
			OutCountFile          = NULL;
		};
		
		DWORD GetFunctionPointers(DWORD ins, void* pHeader) {
			HINSTANCE hInstance = (HINSTANCE)ins;
			m_pHeader = (TCHIP_HEADER*)pHeader; 
			m_devid = ((TCHIP_HEADER*)pHeader)->uID;
			if (hInstance == NULL)
				return FALSE;
			
			//对外接口(38)
			_PinConnect          = (tPinConnect)GetProcAddress(hInstance, "vttPinConnect");
			_WriteVPort          = (tWriteVPort)GetProcAddress(hInstance, "vttWriteVPort");
			GetCpuFre            = (tGetCpuFre)GetProcAddress(hInstance, "vttGetCpuFre");
			GetRunTick           = (tGetRunTick)GetProcAddress(hInstance, "vttGetRunTick");
			_CreateTimerByTick   = (tCreateTimerByTick)GetProcAddress(hInstance, "vttCreateTimerByTick");
			_DeleteTimer         = (tDeleteTimer)GetProcAddress(hInstance, "vttDeleteTimer");
			AddLog               = (tAddLog)GetProcAddress(hInstance, "vttAddLog");
			ClearLog             = (tClearLog)GetProcAddress(hInstance, "vttClearLog");
			RefreshWindows       = (tRefreshWindows)GetProcAddress(hInstance, "vttRefreshWindows");
			SaveState            = (tSaveState)GetProcAddress(hInstance, "vttSaveState");
			LoadState            = (tLoadState)GetProcAddress(hInstance, "vttLoadState");
			_SetDevProperty      = (tSetDevProperty)GetProcAddress(hInstance, "vttSetDevProperty");
			StartDebug           = (tStartDebug)GetProcAddress(hInstance, "vttStartDebug");
			StopDebug            = (tStopDebug)GetProcAddress(hInstance, "vttStopDebug");
			ResetCpu             = (tResetCpu)GetProcAddress(hInstance, "vttResetCpu");
			ResetDebug           = (tResetDebug)GetProcAddress(hInstance, "vttResetDebug");
			IsCpuStopped         = (tIsCpuStopped)GetProcAddress(hInstance, "vttIsCpuStopped");
			FlushCode            = (tFlushCode)GetProcAddress(hInstance, "vttFlushCode");
			GetPrjPath           = (tGetPrjPath)GetProcAddress(hInstance, "vttGetPrjPath");
			ReadByte             = (tReadByte)GetProcAddress(hInstance, "vttReadByte");
			WriteByte            = (tWriteByte)GetProcAddress(hInstance, "vttWriteByte");
			ReadDWORD            = (tReadDWORD)GetProcAddress(hInstance, "vttReadDWORD");
			WriteDWORD           = (tWriteDWORD)GetProcAddress(hInstance, "vttWriteDWORD");
			_SetWatchOnMemory    = (tSetWatchOnMemoryM)GetProcAddress(hInstance, "vttSetWatchOnMemory_m");
			_UnSetWatchOnMemory  = (tUnSetWatchOnMemoryM)GetProcAddress(hInstance, "vttUnSetWatchOnMemory_m");
			SetWatchOnMemory     = (tSetWatchOnMemory)GetProcAddress(hInstance, "vttSetWatchOnMemory");
			UnSetWatchOnMemory   = (tUnSetWatchOnMemory)GetProcAddress(hInstance, "vttUnSetWatchOnMemory");
			_SetWatchOnPc        = (tSetWatchOnPc)GetProcAddress(hInstance, "vttSetWatchOnPc_m");
			_UnSetWatchOnPc      = (tUnSetWatchOnPc)GetProcAddress(hInstance, "vttUnSetWatchOnPc_m");
			OutCoxFile           = (tOutCoxFile)GetProcAddress(hInstance, "vttOutCoxFile");
			OutMCDCCov           = (tOutCoxFile)GetProcAddress(hInstance, "vttOutMCDCCov");
			ClearCov             = (tClearCov)GetProcAddress(hInstance, "vttClearCov");
			GetCurPC             = (tGetCurPC)GetProcAddress(hInstance, "vttGetCurPC");
			GetRegValue          = (tGetRegValue)GetProcAddress(hInstance, "vttGetRegValue");
			SetRegValue          = (tSetRegValue)GetProcAddress(hInstance, "vttSetRegValue");
			GetRegPtrValue       = (tGetRegPtrValue)GetProcAddress(hInstance, "vttGetRegPtrValue");
			SetRegPtrValue       = (tSetRegPtrValue)GetProcAddress(hInstance, "vttSetRegPtrValue");
			_RegSyncCallBack     = (tRegSyncCallBack)GetProcAddress(hInstance, "vttRegSyncCallBack_m");
			GetExpVal            = (tGetExpVal)GetProcAddress(hInstance, "vttGetExpVal");
			GetExpAddr           = (tGetExpAddr)GetProcAddress(hInstance, "vttGetExpAddr");
			SetSymbolValue       = (tSetSymbolValue)GetProcAddress(hInstance, "vttSetSymbolValue");
			DisAssemble          = (tDisAssemble)GetProcAddress(hInstance, "vttDisAssemble");
			
			//内部接口(15)
			CpuIn                = (tCpuIn)GetProcAddress(hInstance, "vttCpuIn");
			CpuOut               = (tCpuOut)GetProcAddress(hInstance, "vttCpuOut");
			ClockSystem          = (tClockSystem)GetProcAddress(hInstance, "vttClockSystem");
			GetRunToTick         = (tGetRunToTick)GetProcAddress(hInstance, "vttGetRunToTick");
			GetFunctionID        = (tGetFunctionID)GetProcAddress(hInstance, "vttGetFunctionID");
			GetFunctionInfo      = (tGetFunctionInfo)GetProcAddress(hInstance, "vttGetFunctionInfo");
			GetFuncNameByAddr    = (tGetFuncNameByAddr)GetProcAddress(hInstance, "vttGetFuncNameByAddr");
			GetCodeSection       = (tGetCodeSection)GetProcAddress(hInstance, "vttGetCodeSection");
			WatchExeAt           = (tWatchExeAt)GetProcAddress(hInstance, "vttWatchExeAt");
			OnSyncEvent          = (tOnSyncEvent)GetProcAddress(hInstance, "vttOnSyncEvent");
			GetStartAddress      = (tGetStartAddress)GetProcAddress(hInstance, "vttGetStartAddress");
			LogInterruptTriger   = (tLogInterruptTriger)GetProcAddress(hInstance, "vttLogInterruptTriger");
			OnDataWatchRead      = (tOnDataWatchRead)GetProcAddress(hInstance, "vttOnDataWatchRead");
			OnDataWatchWrite     = (tOnDataWatchWrite)GetProcAddress(hInstance, "vttOnDataWatchWrite");
			
			//特殊接口(5)
			GetRegID             = (tGetRegID)GetProcAddress(hInstance, "vttGetRegID");
			GetDevID             = (tGetDevID)GetProcAddress(hInstance, "vttGetDevID");
			PinConnectUltra      = (tPinConnectUltra)GetProcAddress(hInstance, "vttPinConnectUltra");
			WriteVportUltra      = (tWriteVPortUltra)GetProcAddress(hInstance, "vttWriteVPortUltra");
			SendMsg              = (tSendMsg)GetProcAddress(hInstance, "vttSendMessage");

			//多核(2)
			GetActiveCoreID      = (tGetActiveCoreID)GetProcAddress(hInstance, "vttGetActiveCoreID");
			SetActiveCoreID      = (tSetActiveCoreID)GetProcAddress(hInstance, "vttSetActiveCoreID");

			//时间点
			SetStartTimeAddr      = (tSetStartTimeAddr)      GetProcAddress(hInstance, "vttSetStartTimeAddr");      
			SetEndTimeAddr        = (tSetEndTimeAddr)        GetProcAddress(hInstance, "vttSetEndTimeAddr");        
			ClearAllTimeCounter   = (tClearAllTimeCounter)   GetProcAddress(hInstance, "vttClearAllTimeCounter");   
			OutCountFile          = (tOutCountFile)          GetProcAddress(hInstance, "vttOutCountFile");          

			return TRUE;
		}
	};
}

extern struct VTTFUNCS vtt;

#endif
