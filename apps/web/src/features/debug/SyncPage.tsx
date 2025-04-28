import React from 'react';
import { SyncDebugInfo } from './components/SyncDebugInfo';
import { Header } from '@/components/layout/header';
import { Main } from '@/components/layout/main';
import { ProfileDropdown } from '@/components/profile-dropdown';
import { Search } from '@/components/search';
import { ThemeSwitch } from '@/components/theme-switch';

export function SyncPage() {
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
          <h1 className='text-2xl font-bold tracking-tight'>Sync Debug</h1>
        </div>
        <SyncDebugInfo showDetailedStats={true} />
      </Main>
    </>
  );
}

export default SyncPage; 