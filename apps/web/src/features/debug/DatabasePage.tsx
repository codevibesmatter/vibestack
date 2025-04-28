import React from 'react';
import { DbDebugPanel } from './components/DbDebugPanel';
import { Header } from '@/components/layout/header';
import { Main } from '@/components/layout/main';
import { ProfileDropdown } from '@/components/profile-dropdown';
import { Search } from '@/components/search';
import { ThemeSwitch } from '@/components/theme-switch';

export function DbDebugPage() {
  return (
    <>
      <Header fixed>
        <Search />
        <div className='ml-auto flex items-center space-x-4'>
          <ThemeSwitch />
          <ProfileDropdown />
        </div>
      </Header>
      <Main>
        <div className="mb-2 flex items-center justify-between space-y-2">
          <h1 className='text-2xl font-bold tracking-tight'>Database Debug</h1>
        </div>
        <DbDebugPanel />
      </Main>
    </>
  );
}

export default DbDebugPage; 