import React from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import { Welcome } from '../components/Welcome';

function HomePage() {
  return (
    <div className="container mx-auto px-4 py-8">
      <Welcome />
    </div>
  );
}

export const Route = createLazyFileRoute('/')({
  component: HomePage
}) 