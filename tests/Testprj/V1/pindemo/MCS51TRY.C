#include <reg52.h>
#define XBYTE ((unsigned char volatile xdata *) 0)

#define int16 unsigned short
#define int32 unsigned int
          
#define TM_BUF 0x8200

void main(void)
{	
/*
	TMOD=0X21; 	
	TH1=0xF0; 
	PCON|=0x80;	
	TCON=0x40; 
	SCON=0xD0;
	IP=0x07; 
	IE=0x97;		
*/


	EA = 1;
//  EX1 = 1;
	EX0 = 1;
//	IT1 = 1;
	IT0 = 1;


	while(1);
}


void INT_SYNC(void) interrupt 0
{	
	static int counter = 0;

	XBYTE[TM_BUF + 0] = counter;
	counter++;
	XBYTE[TM_BUF + 4] = counter;
	counter++;
	
	if (0 == counter%0x10)
		XBYTE[TM_BUF + 16] = counter;

	return;
}

